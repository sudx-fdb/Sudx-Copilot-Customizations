"""
MCP Update Manager — Atomic update pipeline for MCP servers.

Supports Docker image pulls, pip package upgrades, and git repository pulls.
Updates are atomic with rollback on failure. Only one update runs concurrently.
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from models import (
    GlobalConfig,
    InstallMethod,
    ServerConfig,
    ServerStatus,
    UpdateResult,
    UpdateStatus,
)
from mcp_registry import McpRegistry

logger = logging.getLogger("backend.updater")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_UPDATE_LOG_FILE = "update_log.json"
_UPDATE_LOG_MAX_ENTRIES = 500
_LOCK_FILE = ".update.lock"


class McpUpdater:
    """
    Manages atomic updates for MCP servers.

    Each update follows: pre-check → backup → stop → apply → restart → verify → rollback on failure.
    Only one update runs at a time via asyncio.Lock + file lock.
    """

    def __init__(
        self,
        registry: McpRegistry,
        supervisor: Any,  # McpSupervisor
        health_monitor: Any,  # HealthMonitor
        state_dir: Optional[Path] = None,
    ) -> None:
        self._registry = registry
        self._supervisor = supervisor
        self._health_monitor = health_monitor
        self._global: GlobalConfig = registry.global_config
        self._state_dir = state_dir or (Path(self._global.remote_base_path) / self._global.state_dir)
        self._base_path = Path(self._global.remote_base_path)
        self._update_lock = asyncio.Lock()
        self._update_log: List[Dict[str, Any]] = []
        self._last_results: Dict[str, UpdateResult] = {}

        logger.debug("McpUpdater init: state_dir=%s", self._state_dir)
        self._load_update_log()

    def _get_venv_pip_path(self) -> str:
        """Get the platform-correct path to pip in the venv."""
        pip_subdir = "Scripts" if sys.platform == "win32" else "bin"
        return str(self._base_path / self._global.venv_path / pip_subdir / "pip")

    # -----------------------------------------------------------------------
    # Update dispatcher
    # -----------------------------------------------------------------------

    async def update_server(self, name: str) -> UpdateResult:
        """
        Update a single MCP server atomically.

        Args:
            name: Server name.

        Returns:
            UpdateResult with status and details.
        """
        logger.info("Update requested for '%s'", name)

        config = self._registry.get_server_or_raise(name)
        result = UpdateResult(server_name=name, started_at=time.time())

        # Acquire update lock
        if self._update_lock.locked():
            result.status = UpdateStatus.FAILED
            result.error = "Another update is already in progress"
            logger.warning("Update rejected for '%s': lock held", name)
            return result

        async with self._update_lock:
            self._write_lock_file(name)

            try:
                # Pre-update health check
                state = self._supervisor.get_server_status(name)
                if state.status == ServerStatus.UNHEALTHY:
                    result.status = UpdateStatus.FAILED
                    result.error = "Server is unhealthy — skipping update to avoid making it worse"
                    logger.warning("Skipping update for unhealthy server '%s'", name)
                    self._record_update(result)
                    return result

                result.status = UpdateStatus.IN_PROGRESS

                if config.install_method == InstallMethod.DOCKER:
                    await self._update_docker(name, config, result)
                elif config.install_method == InstallMethod.PIP:
                    await self._update_pip(name, config, result)
                elif config.install_method == InstallMethod.SYSTEM:
                    if config.git_repo:
                        await self._update_git(name, config, result)
                    else:
                        result.status = UpdateStatus.FAILED
                        result.error = "System install method with no git_repo — no update path"

                result.completed_at = time.time()
                logger.info(
                    "Update '%s' completed: status=%s, duration=%.1fs",
                    name, result.status, result.duration_seconds or 0,
                )

            except Exception as exc:
                result.status = UpdateStatus.FAILED
                result.error = str(exc)
                result.completed_at = time.time()
                logger.error("Update failed for '%s': %s", name, exc)

            finally:
                self._remove_lock_file()
                self._record_update(result)
                self._last_results[name] = result

        return result

    # -----------------------------------------------------------------------
    # Docker update
    # -----------------------------------------------------------------------

    async def _update_docker(self, name: str, config: ServerConfig, result: UpdateResult) -> None:
        """Docker update: pull new image → compare → restart if changed."""
        image = config.docker_image
        if not image:
            result.status = UpdateStatus.FAILED
            result.error = "No docker_image configured"
            return

        logger.debug("_update_docker('%s'): image=%s", name, image)

        # Get current image ID
        old_id = await self._get_docker_image_id(image)
        result.old_version = old_id
        result.steps_completed.append("captured_old_image_id")

        # Pull new image
        logger.info("Pulling Docker image: %s", image)
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "pull", image,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=600)
            if proc.returncode != 0:
                result.status = UpdateStatus.FAILED
                result.error = f"docker pull failed: {stderr.decode()[:500]}"
                return
            result.steps_completed.append("docker_pull")
        except asyncio.TimeoutError:
            result.status = UpdateStatus.FAILED
            result.error = "docker pull timed out (600s)"
            return

        # Compare image IDs
        new_id = await self._get_docker_image_id(image)
        result.new_version = new_id

        if old_id == new_id:
            result.status = UpdateStatus.SUCCESS
            result.steps_completed.append("no_changes_detected")
            logger.info("Docker image '%s' already up to date", image)
            return

        logger.info("Docker image changed: %s → %s", old_id[:12] if old_id else "none", new_id[:12] if new_id else "none")

        # Stop server
        try:
            await self._supervisor.stop_server(name)
            result.steps_completed.append("server_stopped")
        except Exception as exc:
            logger.error("Failed to stop server '%s' for update: %s", name, exc)

        # Start with new image
        try:
            await self._supervisor.start_server(name)
            result.steps_completed.append("server_restarted")
        except Exception as exc:
            result.status = UpdateStatus.FAILED
            result.error = f"Failed to restart after update: {exc}"
            # Rollback: re-tag old image and restart
            await self._rollback_docker(name, config, old_id, result)
            return

        # Verify health
        await asyncio.sleep(5)  # Give server time to initialize
        health = await self._health_monitor.check_server(name, config)
        if not health.healthy:
            logger.warning("Server '%s' unhealthy after update — rolling back", name)
            await self._rollback_docker(name, config, old_id, result)
            return

        result.status = UpdateStatus.SUCCESS
        result.steps_completed.append("health_verified")
        logger.info("Docker update for '%s' successful", name)

    async def _rollback_docker(self, name: str, config: ServerConfig, old_image_id: Optional[str], result: UpdateResult) -> None:
        """Rollback Docker update by reverting to previous image."""
        logger.warning("Rolling back Docker update for '%s'", name)
        result.rollback_performed = True

        if not old_image_id:
            result.status = UpdateStatus.FAILED
            result.error = "Cannot rollback — no previous image ID"
            return

        try:
            await self._supervisor.stop_server(name)
            # Tag old image back
            if config.docker_image:
                subprocess.run(
                    ["docker", "tag", old_image_id, config.docker_image],
                    capture_output=True, timeout=30,
                )
            await self._supervisor.start_server(name)
            result.status = UpdateStatus.ROLLED_BACK
            result.steps_completed.append("rollback_completed")
        except Exception as exc:
            result.status = UpdateStatus.FAILED
            result.error = f"Rollback failed: {exc}"
            logger.error("Docker rollback failed for '%s': %s", name, exc)

    async def _get_docker_image_id(self, image: str) -> Optional[str]:
        """Get the image ID for a Docker image."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "inspect", "--format={{.Id}}", image,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            if proc.returncode == 0:
                return stdout.decode().strip()
            return None
        except (asyncio.TimeoutError, Exception):
            return None

    # -----------------------------------------------------------------------
    # Pip update
    # -----------------------------------------------------------------------

    async def _update_pip(self, name: str, config: ServerConfig, result: UpdateResult) -> None:
        """Pip update: upgrade package → compare version → restart if changed."""
        package = config.pip_package
        if not package:
            result.status = UpdateStatus.FAILED
            result.error = "No pip_package configured"
            return

        logger.debug("_update_pip('%s'): package=%s", name, package)

        venv_pip = self._get_venv_pip_path()

        # Get current version
        old_version = await self._get_pip_version(venv_pip, package)
        result.old_version = old_version
        result.steps_completed.append("captured_old_version")

        # Upgrade
        logger.info("Upgrading pip package: %s", package)
        try:
            proc = await asyncio.create_subprocess_exec(
                venv_pip, "install", "--upgrade", package,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
            if proc.returncode != 0:
                result.status = UpdateStatus.FAILED
                result.error = f"pip upgrade failed: {stderr.decode()[:500]}"
                return
            result.steps_completed.append("pip_upgrade")
        except asyncio.TimeoutError:
            result.status = UpdateStatus.FAILED
            result.error = "pip upgrade timed out (300s)"
            return

        # Compare versions
        new_version = await self._get_pip_version(venv_pip, package)
        result.new_version = new_version

        if old_version == new_version:
            result.status = UpdateStatus.SUCCESS
            result.steps_completed.append("no_changes_detected")
            logger.info("Package '%s' already up to date (%s)", package, old_version)
            return

        logger.info("Package updated: %s → %s", old_version, new_version)

        # Restart server
        try:
            await self._supervisor.restart_server(name)
            result.steps_completed.append("server_restarted")
        except Exception as exc:
            result.status = UpdateStatus.FAILED
            result.error = f"Failed to restart after update: {exc}"
            await self._rollback_pip(name, venv_pip, package, old_version, result)
            return

        # Verify health
        await asyncio.sleep(3)
        health = await self._health_monitor.check_server(name, config)
        if not health.healthy:
            logger.warning("Server '%s' unhealthy after pip update — rolling back", name)
            await self._rollback_pip(name, venv_pip, package, old_version, result)
            return

        result.status = UpdateStatus.SUCCESS
        result.steps_completed.append("health_verified")

    async def _rollback_pip(self, name: str, pip_path: str, package: str, old_version: Optional[str], result: UpdateResult) -> None:
        """Rollback pip update by installing previous version."""
        logger.warning("Rolling back pip update for '%s'", name)
        result.rollback_performed = True

        if not old_version:
            result.status = UpdateStatus.FAILED
            result.error = "Cannot rollback — no previous version"
            return

        try:
            proc = await asyncio.create_subprocess_exec(
                pip_path, "install", f"{package}=={old_version}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=120)
            await self._supervisor.restart_server(name)
            result.status = UpdateStatus.ROLLED_BACK
            result.steps_completed.append("rollback_completed")
        except Exception as exc:
            result.status = UpdateStatus.FAILED
            result.error = f"Rollback failed: {exc}"
            logger.error("Pip rollback failed for '%s': %s", name, exc)

    async def _get_pip_version(self, pip_path: str, package: str) -> Optional[str]:
        """Get installed version of a pip package."""
        try:
            proc = await asyncio.create_subprocess_exec(
                pip_path, "show", package,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            for line in stdout.decode().splitlines():
                if line.startswith("Version:"):
                    return line.split(":", 1)[1].strip()
            return None
        except (asyncio.TimeoutError, Exception):
            return None

    # -----------------------------------------------------------------------
    # Git update
    # -----------------------------------------------------------------------

    async def _update_git(self, name: str, config: ServerConfig, result: UpdateResult) -> None:
        """Git update: fetch → check for changes → pull → reinstall deps → restart."""
        if not config.git_repo:
            result.status = UpdateStatus.FAILED
            result.error = "No git_repo configured"
            return

        logger.debug("_update_git('%s'): repo=%s", name, config.git_repo)

        # Determine repo directory (assume cloned to data dir)
        repo_dir = self._base_path / self._global.data_dir / name

        if not repo_dir.exists():
            result.status = UpdateStatus.FAILED
            result.error = f"Git repo directory not found: {repo_dir}"
            return

        # Get current SHA
        old_sha = await self._git_current_sha(repo_dir)
        result.old_version = old_sha
        result.steps_completed.append("captured_old_sha")

        # Fetch
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "fetch", "--all",
                cwd=str(repo_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=60)
            result.steps_completed.append("git_fetch")
        except asyncio.TimeoutError:
            result.status = UpdateStatus.FAILED
            result.error = "git fetch timed out"
            return

        # Check for changes
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "log", "HEAD..origin/main", "--oneline",
                cwd=str(repo_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            changes = stdout.decode().strip()
        except (asyncio.TimeoutError, Exception):
            changes = ""

        if not changes:
            result.status = UpdateStatus.SUCCESS
            result.new_version = old_sha
            result.steps_completed.append("no_changes_detected")
            logger.info("Git repo '%s' already up to date", name)
            return

        logger.info("Git changes detected for '%s':\n%s", name, changes[:500])

        # Pull
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "pull", "origin", "main",
                cwd=str(repo_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
            if proc.returncode != 0:
                result.status = UpdateStatus.FAILED
                result.error = f"git pull failed: {stderr.decode()[:500]}"
                return
            result.steps_completed.append("git_pull")
        except asyncio.TimeoutError:
            result.status = UpdateStatus.FAILED
            result.error = "git pull timed out"
            return

        new_sha = await self._git_current_sha(repo_dir)
        result.new_version = new_sha

        # Check if requirements.txt changed
        req_file = repo_dir / "requirements.txt"
        if req_file.exists():
            try:
                venv_pip = self._get_venv_pip_path()
                proc = await asyncio.create_subprocess_exec(
                    venv_pip, "install", "-r", str(req_file),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(proc.communicate(), timeout=300)
                result.steps_completed.append("requirements_installed")
            except (asyncio.TimeoutError, Exception) as exc:
                logger.warning("Requirements install failed for '%s': %s", name, exc)

        # Restart
        try:
            await self._supervisor.restart_server(name)
            result.steps_completed.append("server_restarted")
        except Exception as exc:
            result.status = UpdateStatus.FAILED
            result.error = f"Failed to restart after git update: {exc}"
            await self._rollback_git(name, repo_dir, old_sha, result)
            return

        # Verify health
        await asyncio.sleep(3)
        health = await self._health_monitor.check_server(name, config)
        if not health.healthy:
            logger.warning("Server '%s' unhealthy after git update — rolling back", name)
            await self._rollback_git(name, repo_dir, old_sha, result)
            return

        result.status = UpdateStatus.SUCCESS
        result.steps_completed.append("health_verified")

    async def _rollback_git(self, name: str, repo_dir: Path, old_sha: Optional[str], result: UpdateResult) -> None:
        """Rollback git update using git reset --hard."""
        logger.warning("Rolling back git update for '%s'", name)
        result.rollback_performed = True

        if not old_sha:
            result.status = UpdateStatus.FAILED
            result.error = "Cannot rollback — no previous SHA"
            return

        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "reset", "--hard", old_sha,
                cwd=str(repo_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=30)
            await self._supervisor.restart_server(name)
            result.status = UpdateStatus.ROLLED_BACK
            result.steps_completed.append("rollback_completed")
        except Exception as exc:
            result.status = UpdateStatus.FAILED
            result.error = f"Git rollback failed: {exc}"
            logger.error("Git rollback failed for '%s': %s", name, exc)

    async def _git_current_sha(self, repo_dir: Path) -> Optional[str]:
        """Get current git HEAD SHA."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "rev-parse", "HEAD",
                cwd=str(repo_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            return stdout.decode().strip() if proc.returncode == 0 else None
        except (asyncio.TimeoutError, Exception):
            return None

    # -----------------------------------------------------------------------
    # Batch operations
    # -----------------------------------------------------------------------

    async def update_all(self) -> Dict[str, UpdateResult]:
        """
        Update all enabled servers sequentially.

        Returns:
            Dict of server name → UpdateResult.
        """
        logger.info("=== UPDATE ALL ===")
        results: Dict[str, UpdateResult] = {}
        enabled = self._registry.get_enabled_servers()

        for name in enabled:
            try:
                results[name] = await self.update_server(name)
            except Exception as exc:
                logger.error("Update failed for '%s': %s", name, exc)
                results[name] = UpdateResult(
                    server_name=name,
                    status=UpdateStatus.FAILED,
                    error=str(exc),
                    completed_at=time.time(),
                )

        logger.info("Update all complete: %d/%d successful", sum(1 for r in results.values() if r.status == UpdateStatus.SUCCESS), len(results))
        return results

    async def check_updates_available(self) -> Dict[str, bool]:
        """
        Check if updates are available for each server (dry-run).

        Returns:
            Dict of server name → True if update available.
        """
        logger.debug("check_updates_available()")
        available: Dict[str, bool] = {}
        enabled = self._registry.get_enabled_servers()

        for name, config in enabled.items():
            try:
                if config.install_method == InstallMethod.DOCKER and config.docker_image:
                    available[name] = await self._check_docker_update(config.docker_image)
                elif config.install_method == InstallMethod.PIP and config.pip_package:
                    venv_pip = self._get_venv_pip_path()
                    available[name] = await self._check_pip_update(venv_pip, config.pip_package)
                elif config.git_repo:
                    repo_dir = self._base_path / self._global.data_dir / name
                    available[name] = await self._check_git_update(repo_dir)
                else:
                    available[name] = False
            except Exception as exc:
                logger.debug("Update check failed for '%s': %s", name, exc)
                available[name] = False

        return available

    async def _check_docker_update(self, image: str) -> bool:
        """Check if a newer Docker image exists."""
        old_id = await self._get_docker_image_id(image)
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "pull", image,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.communicate(), timeout=300)
        except (asyncio.TimeoutError, Exception):
            return False
        new_id = await self._get_docker_image_id(image)
        return old_id != new_id

    async def _check_pip_update(self, pip_path: str, package: str) -> bool:
        """Check if a newer pip package version exists."""
        try:
            proc = await asyncio.create_subprocess_exec(
                pip_path, "install", f"{package}==__check__",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            # pip error will list available versions
            output = stderr.decode()
            current = await self._get_pip_version(pip_path, package)
            if current and current in output:
                # Parse available versions from pip error
                # If error contains versions newer than current, update available
                return "from versions:" in output.lower()
            return False
        except (asyncio.TimeoutError, Exception):
            return False

    async def _check_git_update(self, repo_dir: Path) -> bool:
        """Check if remote has new commits."""
        if not repo_dir.exists():
            return False
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "fetch", "--all",
                cwd=str(repo_dir),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.communicate(), timeout=30)

            proc = await asyncio.create_subprocess_exec(
                "git", "log", "HEAD..origin/main", "--oneline",
                cwd=str(repo_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
            return bool(stdout.decode().strip())
        except (asyncio.TimeoutError, Exception):
            return False

    # -----------------------------------------------------------------------
    # Update log persistence
    # -----------------------------------------------------------------------

    def _record_update(self, result: UpdateResult) -> None:
        """Add an update result to the persistent log."""
        entry = result.model_dump()
        self._update_log.append(entry)

        # Cap log size
        if len(self._update_log) > _UPDATE_LOG_MAX_ENTRIES:
            self._update_log = self._update_log[-_UPDATE_LOG_MAX_ENTRIES:]

        self._flush_update_log()

    def _flush_update_log(self) -> None:
        """Persist update log to disk."""
        log_path = self._state_dir / _UPDATE_LOG_FILE
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.write_text(json.dumps(self._update_log, indent=2, default=str), encoding="utf-8")
            logger.debug("Update log flushed: %d entries", len(self._update_log))
        except Exception as exc:
            logger.error("Failed to flush update log: %s", exc)

    def _load_update_log(self) -> None:
        """Load update log from disk."""
        log_path = self._state_dir / _UPDATE_LOG_FILE
        try:
            if log_path.exists():
                raw = log_path.read_text(encoding="utf-8")
                self._update_log = json.loads(raw)
                logger.debug("Loaded update log: %d entries", len(self._update_log))
        except Exception as exc:
            logger.error("Failed to load update log: %s", exc)
            self._update_log = []

    # -----------------------------------------------------------------------
    # Lock file
    # -----------------------------------------------------------------------

    def _write_lock_file(self, name: str) -> None:
        """Write update lock file for crash safety."""
        lock_path = self._state_dir / _LOCK_FILE
        try:
            lock_path.write_text(
                json.dumps({"server": name, "started_at": time.time()}),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.warning("Failed to write lock file: %s", exc)

    def _remove_lock_file(self) -> None:
        """Remove update lock file."""
        lock_path = self._state_dir / _LOCK_FILE
        try:
            if lock_path.exists():
                lock_path.unlink()
        except Exception as exc:
            logger.warning("Failed to remove lock file: %s", exc)

    # -----------------------------------------------------------------------
    # Properties
    # -----------------------------------------------------------------------

    @property
    def last_results(self) -> Dict[str, UpdateResult]:
        """Get the last update result per server."""
        return dict(self._last_results)

    @property
    def update_log(self) -> List[Dict[str, Any]]:
        """Get the full update log."""
        return list(self._update_log)
