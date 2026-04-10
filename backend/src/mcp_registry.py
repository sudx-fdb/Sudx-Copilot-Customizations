"""
MCP Server Registry — Central configuration loader and typed access.

Loads and validates backend/config/mcp_servers.json, provides getter functions
for server configs, and supports hot-reload on SIGHUP.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import signal
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from pydantic import ValidationError

from models import (
    GlobalConfig,
    InstallMethod,
    McpServersConfig,
    ServerConfig,
    TransportType,
)

logger = logging.getLogger("backend.registry")

# ---------------------------------------------------------------------------
# JSON Schema Validation (structural, beyond Pydantic)
# ---------------------------------------------------------------------------

_REQUIRED_SERVER_FIELDS = {"enabled", "install_method", "start_command", "transport"}
_VALID_INSTALL_METHODS = {e.value for e in InstallMethod}
_VALID_TRANSPORTS = {e.value for e in TransportType}


class ConfigValidationError(Exception):
    """Raised when mcp_servers.json fails structural or semantic validation."""

    def __init__(self, errors: List[str]) -> None:
        self.errors = errors
        super().__init__(f"Config validation failed with {len(errors)} error(s):\n" + "\n".join(f"  - {e}" for e in errors))


def _validate_raw_config(raw: Dict[str, Any]) -> List[str]:
    """
    Validate raw JSON structure before Pydantic parsing.
    Returns list of error strings (empty = valid).
    """
    errors: List[str] = []
    logger.debug("Running structural validation on raw config")

    if "servers" not in raw:
        errors.append("Missing top-level 'servers' key")
        return errors

    servers = raw["servers"]
    if not isinstance(servers, dict):
        errors.append("'servers' must be an object/dict")
        return errors

    for name, cfg in servers.items():
        prefix = f"servers.{name}"

        if not isinstance(cfg, dict):
            errors.append(f"{prefix}: must be an object")
            continue

        # Check required fields
        for field in _REQUIRED_SERVER_FIELDS:
            if field not in cfg:
                errors.append(f"{prefix}: missing required field '{field}'")

        # Validate install_method value
        method = cfg.get("install_method")
        if method and method not in _VALID_INSTALL_METHODS:
            errors.append(f"{prefix}: invalid install_method '{method}' — must be one of {_VALID_INSTALL_METHODS}")

        # Validate transport value
        transport = cfg.get("transport")
        if transport and transport not in _VALID_TRANSPORTS:
            errors.append(f"{prefix}: invalid transport '{transport}' — must be one of {_VALID_TRANSPORTS}")

        # Docker servers must have docker_image or docker_compose_file
        if method == "docker":
            if not cfg.get("docker_image") and not cfg.get("docker_compose_file"):
                errors.append(f"{prefix}: docker install_method requires 'docker_image' or 'docker_compose_file'")

        # SSE/streamable-http servers must have mcp_endpoint
        if transport in ("sse", "streamable-http") and not cfg.get("mcp_endpoint"):
            errors.append(f"{prefix}: transport '{transport}' requires 'mcp_endpoint'")

        # Health check validation
        hc = cfg.get("health_check")
        if isinstance(hc, dict):
            hc_type = hc.get("type")
            if hc_type == "http" and not hc.get("target", "").startswith("http"):
                errors.append(f"{prefix}.health_check: type 'http' requires target starting with 'http'")
            if hc_type == "command" and not hc.get("target"):
                errors.append(f"{prefix}.health_check: type 'command' requires non-empty target")

        # Dependency check (depends_on references must be valid server names)
        deps = cfg.get("depends_on", [])
        if isinstance(deps, list):
            for dep in deps:
                if dep not in servers:
                    errors.append(f"{prefix}: depends_on references unknown server '{dep}'")

    if errors:
        logger.warning("Structural validation found %d error(s)", len(errors))
    else:
        logger.debug("Structural validation passed")

    return errors


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

class McpRegistry:
    """
    Central registry for MCP server configurations.

    Loads and validates mcp_servers.json, provides typed access to server
    configs, and supports hot-reload on SIGHUP signal.
    """

    def __init__(self, config_path: Optional[Path] = None, auto_signal: bool = True) -> None:
        """
        Initialize the registry.

        Args:
            config_path: Path to mcp_servers.json. Defaults to backend/config/mcp_servers.json.
            auto_signal: Whether to register SIGHUP handler for hot-reload (Unix only).
        """
        self._config_path: Path = config_path or (Path(__file__).parent.parent / "config" / "mcp_servers.json")
        self._config: Optional[McpServersConfig] = None
        self._config_hash: Optional[str] = None
        self._load_time: float = 0.0
        self._lock = threading.RLock()
        self._reload_callbacks: List[Callable[[], None]] = []

        logger.debug("McpRegistry initializing with config_path=%s, auto_signal=%s", self._config_path, auto_signal)

        # Register SIGHUP handler for hot-reload (Unix only, skip on Windows)
        if auto_signal and hasattr(signal, "SIGHUP"):
            try:
                signal.signal(signal.SIGHUP, self._sighup_handler)
                logger.debug("SIGHUP handler registered for config hot-reload")
            except (OSError, ValueError) as exc:
                logger.warning("Could not register SIGHUP handler: %s", exc)

        # Initial load
        self.load()

    def _sighup_handler(self, signum: int, frame: Any) -> None:
        """Handle SIGHUP signal — triggers config hot-reload."""
        logger.info("SIGHUP received — reloading mcp_servers.json")
        try:
            self.reload()
        except Exception as exc:
            logger.error("Hot-reload failed on SIGHUP: %s", exc)

    def _compute_hash(self, raw_bytes: bytes) -> str:
        """Compute SHA-256 hash of config file content."""
        return hashlib.sha256(raw_bytes).hexdigest()

    def load(self) -> McpServersConfig:
        """
        Load and validate mcp_servers.json.

        Returns:
            Parsed and validated McpServersConfig.

        Raises:
            FileNotFoundError: If config file doesn't exist.
            ConfigValidationError: If config fails structural validation.
            ValidationError: If config fails Pydantic validation.
        """
        logger.debug("Loading config from %s", self._config_path)

        if not self._config_path.exists():
            logger.error("Config file not found: %s", self._config_path)
            raise FileNotFoundError(f"Config file not found: {self._config_path}")

        raw_bytes = self._config_path.read_bytes()
        new_hash = self._compute_hash(raw_bytes)

        try:
            raw = json.loads(raw_bytes)
        except json.JSONDecodeError as exc:
            logger.error("Invalid JSON in %s: %s", self._config_path, exc)
            raise ConfigValidationError([f"Invalid JSON: {exc}"]) from exc

        # Structural validation
        structural_errors = _validate_raw_config(raw)
        if structural_errors:
            raise ConfigValidationError(structural_errors)

        # Pydantic model validation
        try:
            config = McpServersConfig.model_validate(raw)
        except ValidationError as exc:
            error_messages = [f"{'.'.join(str(l) for l in e['loc'])}: {e['msg']}" for e in exc.errors()]
            logger.error("Pydantic validation failed: %s", error_messages)
            raise ConfigValidationError(error_messages) from exc

        with self._lock:
            self._config = config
            self._config_hash = new_hash
            self._load_time = time.time()

        logger.info(
            "Config loaded: %d server(s) (%d enabled), hash=%s",
            len(config.servers),
            sum(1 for s in config.servers.values() if s.enabled),
            new_hash[:12],
        )

        return config

    def reload(self) -> bool:
        """
        Reload config if it has changed on disk.

        Returns:
            True if config was reloaded, False if unchanged.
        """
        logger.debug("Checking for config changes...")

        if not self._config_path.exists():
            logger.warning("Config file gone during reload check: %s", self._config_path)
            return False

        raw_bytes = self._config_path.read_bytes()
        new_hash = self._compute_hash(raw_bytes)

        if new_hash == self._config_hash:
            logger.debug("Config unchanged (hash=%s)", new_hash[:12])
            return False

        logger.info("Config changed (old=%s, new=%s) — reloading", self._config_hash[:12] if self._config_hash else "none", new_hash[:12])

        old_config = self._config
        try:
            self.load()
            # Notify callbacks
            for callback in self._reload_callbacks:
                try:
                    callback()
                except Exception as exc:
                    logger.error("Reload callback failed: %s", exc)
            return True
        except Exception as exc:
            logger.error("Reload failed, keeping previous config: %s", exc)
            with self._lock:
                self._config = old_config
            return False

    def on_reload(self, callback: Callable[[], None]) -> None:
        """Register a callback to be called after successful config reload."""
        self._reload_callbacks.append(callback)
        logger.debug("Reload callback registered (total: %d)", len(self._reload_callbacks))

    # -----------------------------------------------------------------------
    # Getters
    # -----------------------------------------------------------------------

    @property
    def config(self) -> McpServersConfig:
        """Get the full parsed config. Raises RuntimeError if not loaded."""
        with self._lock:
            if self._config is None:
                raise RuntimeError("Registry not loaded — call load() first")
            return self._config

    @property
    def global_config(self) -> GlobalConfig:
        """Get the global configuration section."""
        return self.config.global_config

    @property
    def config_hash(self) -> Optional[str]:
        """Get the SHA-256 hash of the current config file."""
        with self._lock:
            return self._config_hash

    @property
    def load_time(self) -> float:
        """Timestamp of the last successful config load."""
        with self._lock:
            return self._load_time

    def get_server(self, name: str) -> Optional[ServerConfig]:
        """
        Get a single server config by name.

        Args:
            name: Server name as defined in mcp_servers.json.

        Returns:
            ServerConfig or None if not found.
        """
        logger.debug("get_server(%s)", name)
        server = self.config.servers.get(name)
        if server is None:
            logger.debug("Server '%s' not found in registry", name)
        return server

    def get_server_or_raise(self, name: str) -> ServerConfig:
        """
        Get a single server config by name, raising KeyError if not found.

        Args:
            name: Server name as defined in mcp_servers.json.

        Returns:
            ServerConfig.

        Raises:
            KeyError: If server name not found.
        """
        server = self.get_server(name)
        if server is None:
            raise KeyError(f"Unknown server: '{name}'. Available: {list(self.config.servers.keys())}")
        return server

    def get_all_servers(self) -> Dict[str, ServerConfig]:
        """Get all server configs (including disabled)."""
        logger.debug("get_all_servers() — %d total", len(self.config.servers))
        return dict(self.config.servers)

    def get_enabled_servers(self) -> Dict[str, ServerConfig]:
        """Get only enabled server configs."""
        enabled = {name: cfg for name, cfg in self.config.servers.items() if cfg.enabled}
        logger.debug("get_enabled_servers() — %d of %d enabled", len(enabled), len(self.config.servers))
        return enabled

    def get_servers_by_tag(self, tag: str) -> Dict[str, ServerConfig]:
        """
        Get all servers that have a specific tag.

        Args:
            tag: Tag to filter by (case-sensitive).

        Returns:
            Dict of matching server name → ServerConfig.
        """
        matched = {name: cfg for name, cfg in self.config.servers.items() if tag in cfg.tags}
        logger.debug("get_servers_by_tag('%s') — %d matched", tag, len(matched))
        return matched

    def get_servers_by_transport(self, transport: TransportType) -> Dict[str, ServerConfig]:
        """Get all servers using a specific transport type."""
        matched = {name: cfg for name, cfg in self.config.servers.items() if cfg.transport == transport}
        logger.debug("get_servers_by_transport(%s) — %d matched", transport.value, len(matched))
        return matched

    def get_servers_by_install_method(self, method: InstallMethod) -> Dict[str, ServerConfig]:
        """Get all servers using a specific install method."""
        matched = {name: cfg for name, cfg in self.config.servers.items() if cfg.install_method == method}
        logger.debug("get_servers_by_install_method(%s) — %d matched", method.value, len(matched))
        return matched

    def get_server_names(self) -> List[str]:
        """Get list of all server names."""
        return list(self.config.servers.keys())

    def get_dependency_order(self) -> List[str]:
        """
        Get server names in topological order based on depends_on.
        Servers with no dependencies come first.
        Uses Kahn's algorithm for deterministic ordering.

        Returns:
            Ordered list of server names.

        Raises:
            ValueError: If circular dependencies detected.
        """
        logger.debug("Computing dependency order...")

        servers = self.config.servers
        # Build adjacency and in-degree
        in_degree: Dict[str, int] = {name: 0 for name in servers}
        dependents: Dict[str, List[str]] = {name: [] for name in servers}

        for name, cfg in servers.items():
            for dep in cfg.depends_on:
                if dep in servers:
                    in_degree[name] += 1
                    dependents[dep].append(name)

        # Kahn's algorithm
        queue = [name for name, degree in in_degree.items() if degree == 0]
        queue.sort()  # Deterministic ordering for same-level nodes
        result: List[str] = []

        while queue:
            node = queue.pop(0)
            result.append(node)
            for dependent in sorted(dependents[node]):
                in_degree[dependent] -= 1
                if in_degree[dependent] == 0:
                    queue.append(dependent)

        if len(result) != len(servers):
            unresolved = set(servers.keys()) - set(result)
            logger.error("Circular dependency detected among: %s", unresolved)
            raise ValueError(f"Circular dependency detected among: {unresolved}")

        logger.debug("Dependency order: %s", result)
        return result


# ---------------------------------------------------------------------------
# Module-level singleton (lazy)
# ---------------------------------------------------------------------------

_registry_instance: Optional[McpRegistry] = None
_registry_lock = threading.Lock()


def get_registry(config_path: Optional[Path] = None) -> McpRegistry:
    """
    Get or create the global McpRegistry singleton.

    Args:
        config_path: Optional path override for first initialization.

    Returns:
        The shared McpRegistry instance.
    """
    global _registry_instance
    if _registry_instance is None:
        with _registry_lock:
            if _registry_instance is None:
                logger.debug("Creating global McpRegistry singleton")
                _registry_instance = McpRegistry(config_path=config_path)
    return _registry_instance
