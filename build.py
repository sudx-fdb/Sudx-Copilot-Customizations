#!/usr/bin/env python3
"""Sudx Copilot Customizations — VSIX Build & Version Control Utility.

Handles semantic versioning (Fix/NewFunction/MayjorUpdate), VSIX packaging, 
and version history management for the Sudx Copilot Customizations VS Code extension.

Build structure:
    .builds/{version}-{name}-{tag}-sudxai.vsix      Aktuelle VSIX (immer nur eine)
    .builds/versions/{version}-{name}-{tag}-sudxai.vsix  Archivierte fruehere Versionen
    .builds/versions.json                            Versionshistorie und Metadaten

Versioning:
    Fix                    +0.0.1   (Patch)
    NewFunction            +0.1.0   (Minor, patch reset)
    UserapprovedBigBump    +1.0.0   (Major, minor+patch reset, nur mit --allow-bigbump)

Release Tags (Pflicht, eines von beiden):
    -Normal                Unstable Release (prerelease)
    -UserapprovedStable    Stable Release

Total-Version:
    Kumuliert alle Inkremente ohne Reset.
    Fix +0.0.1 | NewFunction +0.1.0 (patch bleibt) | UserapprovedBigBump +1.0.0 (minor+patch bleiben)

Build-Nummer:
    {version}.{totalversion}.{HH.MM.DD:MM:YYYY}-{name}

Kommentar-Prefixe (Pflicht):
    FIX:   Reparatur oder Anpassung einer bestehenden Funktion
    NEU:   Neue Funktionalitaet fuer Nutzer
    REM:   Entfernung oder groessere Restrukturierung
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


# ---------------------------------------------------------------------------
#  Terminal-Farben (Windows-kompatibel ueber ANSI falls unterstuetzt)
# ---------------------------------------------------------------------------

class _Colors:
    """ANSI color codes with Windows fallback."""

    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    CYAN = "\033[96m"
    MAGENTA = "\033[95m"
    WHITE = "\033[97m"

    @classmethod
    def disable(cls) -> None:
        for attr in ("RESET", "BOLD", "DIM", "RED", "GREEN", "YELLOW", "CYAN", "MAGENTA", "WHITE"):
            setattr(cls, attr, "")

    @classmethod
    def init(cls) -> None:
        """Enable ANSI on Windows 10+ or disable colors if unsupported."""
        if sys.platform == "win32":
            try:
                import ctypes
                kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
                handle = kernel32.GetStdHandle(-11)
                mode = ctypes.c_ulong()
                kernel32.GetConsoleMode(handle, ctypes.byref(mode))
                kernel32.SetConsoleMode(handle, mode.value | 0x0004)
            except Exception:
                cls.disable()
        if not sys.stdout.isatty():
            cls.disable()


C = _Colors


def _print_header(text: str) -> None:
    print(f"\n{C.BOLD}{C.CYAN}{'=' * 60}{C.RESET}")
    print(f"{C.BOLD}{C.CYAN}  {text}{C.RESET}")
    print(f"{C.BOLD}{C.CYAN}{'=' * 60}{C.RESET}")


def _print_success(text: str) -> None:
    print(f"{C.GREEN}{C.BOLD}[OK]{C.RESET} {text}")


def _print_error(text: str) -> None:
    print(f"{C.RED}{C.BOLD}[FEHLER]{C.RESET} {text}", file=sys.stderr)


def _print_warn(text: str) -> None:
    print(f"{C.YELLOW}{C.BOLD}[WARNUNG]{C.RESET} {text}", file=sys.stderr)


def _print_info(label: str, value: str) -> None:
    print(f"  {C.DIM}{label:<20}{C.RESET} {C.WHITE}{value}{C.RESET}")


def _print_separator() -> None:
    print(f"{C.DIM}{'-' * 60}{C.RESET}")


# ---------------------------------------------------------------------------
#  Semantic Version
# ---------------------------------------------------------------------------

@dataclass(frozen=True, order=True)
class Version:
    """Semantic version major.minor.patch."""

    major: int
    minor: int
    patch: int

    VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")

    @classmethod
    def from_string(cls, version_str: str) -> Version:
        m = cls.VERSION_RE.match(version_str.strip())
        if not m:
            raise ValueError(f"Ungueltiges Versionsformat: '{version_str}'. Erwartet: X.Y.Z")
        return cls(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    def __str__(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"

    # -- version (mit reset) ------------------------------------------------

    def increment_fix(self) -> Version:
        """Fix: +0.0.1"""
        return Version(self.major, self.minor, self.patch + 1)

    def increment_newfunction(self) -> Version:
        """NewFunction: +0.1.0 (patch reset)"""
        return Version(self.major, self.minor + 1, 0)

    def increment_bigbump(self) -> Version:
        """UserapprovedBigBump: +1.0.0 (minor+patch reset)"""
        return Version(self.major + 1, 0, 0)

    # -- total-version (ohne reset) -----------------------------------------

    def total_increment_fix(self) -> Version:
        """Total Fix: +0.0.1"""
        return Version(self.major, self.minor, self.patch + 1)

    def total_increment_newfunction(self) -> Version:
        """Total NewFunction: +0.1.0 (patch bleibt)"""
        return Version(self.major, self.minor + 1, self.patch)

    def total_increment_bigbump(self) -> Version:
        """Total UserapprovedBigBump: +1.0.0 (minor+patch bleiben)"""
        return Version(self.major + 1, self.minor, self.patch)


# ---------------------------------------------------------------------------
#  Kommentar-Validierung
# ---------------------------------------------------------------------------

VALID_COMMENT_PREFIXES = ("FIX:", "NEU:", "REM:")

COMMENT_PREFIX_FOR_TYPE: dict[str, str] = {
    "Fix": "FIX:",
    "NewFunction": "NEU:",
    "UserapprovedBigBump": "REM:",
}

COMMENT_PREFIX_DESCRIPTIONS: dict[str, str] = {
    "FIX:": "Reparatur oder Anpassung einer bestehenden Funktion",
    "NEU:": "Neue Funktionalitaet fuer Nutzer",
    "REM:": "Entfernung oder groessere Restrukturierung",
}


def validate_comment(comment: str, change_type: str) -> tuple[bool, str]:
    """Validate that the comment has a valid prefix matching the change type.

    Returns (ok, error_or_cleaned_comment).
    """
    if not comment or not comment.strip():
        return False, (
            "Kommentar darf nicht leer sein.\n"
            f"  Pflicht-Prefix fuer {change_type}: {COMMENT_PREFIX_FOR_TYPE[change_type]}\n"
            f"  Erlaubte Prefixe: {', '.join(VALID_COMMENT_PREFIXES)}\n"
            f"  Beispiel: \"{COMMENT_PREFIX_FOR_TYPE[change_type]} Kurzbeschreibung der Aenderung\""
        )

    comment = comment.strip()

    matched_prefix = None
    for prefix in VALID_COMMENT_PREFIXES:
        if comment.upper().startswith(prefix):
            matched_prefix = prefix
            break

    if matched_prefix is None:
        return False, (
            f"Kommentar muss mit einem gueltigen Prefix beginnen.\n"
            f"  Erhalten:  \"{comment}\"\n"
            f"  Erwartet:  {COMMENT_PREFIX_FOR_TYPE[change_type]} <Beschreibung>\n"
            f"  Erlaubt:   {', '.join(f'{p} ({d})' for p, d in COMMENT_PREFIX_DESCRIPTIONS.items())}"
        )

    body = comment[len(matched_prefix):].strip()
    if not body:
        return False, (
            f"Nach dem Prefix '{matched_prefix}' muss eine Beschreibung folgen.\n"
            f"  Beispiel: \"{matched_prefix} Kurzbeschreibung der Aenderung\""
        )

    expected = COMMENT_PREFIX_FOR_TYPE.get(change_type, "")
    if matched_prefix != expected:
        _print_warn(
            f"Empfohlenes Prefix fuer {change_type} ist '{expected}', "
            f"verwendet wird '{matched_prefix}'."
        )

    cleaned = f"{matched_prefix} {body}"
    return True, cleaned


# ---------------------------------------------------------------------------
#  Name-Validierung
# ---------------------------------------------------------------------------

NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
NAME_MIN_LEN = 2
NAME_MAX_LEN = 32


def validate_name(name: str) -> tuple[bool, str]:
    """Validate version name (must be single unique word, alpha-start)."""
    if not name or not name.strip():
        return False, "Versionsname darf nicht leer sein."

    name = name.strip()

    if len(name) < NAME_MIN_LEN:
        return False, f"Versionsname muss mindestens {NAME_MIN_LEN} Zeichen haben (erhalten: {len(name)})."

    if len(name) > NAME_MAX_LEN:
        return False, f"Versionsname darf maximal {NAME_MAX_LEN} Zeichen haben (erhalten: {len(name)})."

    if " " in name:
        return False, f"Versionsname muss genau ein Wort sein (keine Leerzeichen). Erhalten: '{name}'"

    if not NAME_PATTERN.fullmatch(name):
        return False, (
            f"Versionsname darf nur Buchstaben, Ziffern, _ und - enthalten "
            f"und muss mit einem Buchstaben beginnen. Erhalten: '{name}'"
        )

    return True, name


# ---------------------------------------------------------------------------
#  Lock-Datei (Schutz gegen gleichzeitige Ausfuehrung)
# ---------------------------------------------------------------------------

class VersionLock:
    """Simple file-based lock to prevent concurrent build.py runs."""

    def __init__(self, lock_path: Path):
        self.lock_path = lock_path
        self._acquired = False

    def acquire(self) -> bool:
        if self.lock_path.exists():
            try:
                lock_data = json.loads(self.lock_path.read_text(encoding="utf-8"))
                pid = lock_data.get("pid", "?")
                started = lock_data.get("started", "?")
                _print_error(
                    f"Build-Vorgang bereits aktiv (PID {pid}, gestartet {started}).\n"
                    f"  Lock-Datei: {self.lock_path}\n"
                    f"  Falls kein anderer Prozess laeuft: Lock-Datei manuell loeschen."
                )
            except Exception:
                _print_error(f"Lock-Datei existiert: {self.lock_path}")
            return False

        lock_data = {
            "pid": os.getpid(),
            "started": datetime.now().isoformat(),
        }
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        self.lock_path.write_text(json.dumps(lock_data), encoding="utf-8")
        self._acquired = True
        return True

    def release(self) -> None:
        if self._acquired and self.lock_path.exists():
            self.lock_path.unlink(missing_ok=True)
            self._acquired = False


# ---------------------------------------------------------------------------
#  File Size Helper
# ---------------------------------------------------------------------------

def _human_size(size_bytes: int) -> str:
    """Format byte count as human-readable string."""
    size = float(size_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


# ---------------------------------------------------------------------------
#  Build Manager
# ---------------------------------------------------------------------------

class BuildManager:
    """Core manager for VSIX building, versioning, and history."""

    CHANGE_TYPES = ("Fix", "NewFunction", "UserapprovedBigBump")
    VSIX_MIN_SIZE = 1024  # 1 KB minimum for a valid VSIX
    VSIX_SUFFIX = "-sudxai.vsix"

    def __init__(self, repo_root: Path):
        self.repo_root = repo_root
        self.plugin_dir = repo_root / "plugin"
        self.builds_dir = repo_root / ".builds"
        self.versions_archive_dir = self.builds_dir / "versions"
        self.history_file = self.builds_dir / "versions.json"
        self.lock_file = self.builds_dir / ".build.lock"
        self.package_json_path = self.plugin_dir / "package.json"
        self._lock = VersionLock(self.lock_file)

    # -- History I/O --------------------------------------------------------

    def _load_history(self) -> dict:
        if self.history_file.exists():
            with open(self.history_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            if "records" not in data or not isinstance(data.get("records"), list):
                data["records"] = []
            if "current_version" not in data:
                data["current_version"] = "0.0.0"
            if "total_version" not in data:
                data["total_version"] = "0.0.0"
            return data
        return {"current_version": "0.0.0", "total_version": "0.0.0", "records": []}

    def _save_history(self, data: dict) -> None:
        self.builds_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.history_file.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=True)
            f.write("\n")
        tmp.replace(self.history_file)

    # -- Validierungen ------------------------------------------------------

    def is_name_unique(self, name: str) -> bool:
        """Check if version name has never been used (case-insensitive)."""
        try:
            history = self._load_history()
            lower = name.lower()
            for rec in history.get("records", []):
                if isinstance(rec, dict) and rec.get("name", "").lower() == lower:
                    return False
            return True
        except Exception:
            return True

    # -- Archivierung -------------------------------------------------------

    def _archive_current_vsix(self) -> int:
        """Move all current VSIX files from .builds/ into versions/ archive.

        Returns the number of items archived.
        """
        archived = 0
        if not self.builds_dir.exists():
            return archived

        self.versions_archive_dir.mkdir(parents=True, exist_ok=True)

        for item in list(self.builds_dir.iterdir()):
            if not item.is_file() or not item.name.endswith(".vsix"):
                continue

            dest = self.versions_archive_dir / item.name
            if dest.exists():
                dest.unlink()
            shutil.move(str(item), str(dest))
            archived += 1

        return archived

    # -- package.json Handling ----------------------------------------------

    def _read_package_json(self) -> dict:
        """Read and parse plugin/package.json."""
        with open(self.package_json_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _write_package_json(self, data: dict) -> None:
        """Write plugin/package.json atomically (indent 2 + trailing newline)."""
        tmp = self.package_json_path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        tmp.replace(self.package_json_path)

    def _update_package_json(self, version_str: str) -> dict:
        """Update version in package.json and return original data for rollback."""
        original = self._read_package_json()
        updated = self._read_package_json()  # fresh copy
        updated["version"] = version_str
        self._write_package_json(updated)
        return original

    def _restore_package_json(self, original_data: dict) -> None:
        """Restore package.json to original state (rollback on build failure)."""
        try:
            self._write_package_json(original_data)
            _print_warn("package.json auf vorherige Version zurueckgesetzt.")
        except Exception as e:
            _print_error(f"Konnte package.json nicht restaurieren: {e}")

    # -- vsce / npm Handling ------------------------------------------------

    def _check_vsce_installed(self) -> bool:
        """Check if @vscode/vsce is available via npx."""
        try:
            result = subprocess.run(
                ["npx", "@vscode/vsce", "--version"],
                cwd=str(self.plugin_dir),
                capture_output=True,
                text=True,
                timeout=30,
                shell=True,
            )
            if result.returncode == 0:
                version = result.stdout.strip().split("\n")[-1]
                _print_info("vsce Version:", version)
                return True
            return False
        except Exception:
            return False

    def _run_npm_install(self) -> bool:
        """Run npm install in plugin/ if node_modules is missing."""
        node_modules = self.plugin_dir / "node_modules"
        if node_modules.exists():
            return True

        _print_info("npm install:", "node_modules fehlt, installiere...")
        try:
            result = subprocess.run(
                ["npm", "install"],
                cwd=str(self.plugin_dir),
                capture_output=True,
                text=True,
                timeout=120,
                shell=True,
            )
            if result.returncode == 0:
                _print_success("npm install erfolgreich")
                return True
            _print_error(f"npm install fehlgeschlagen:\n{result.stderr}")
            return False
        except subprocess.TimeoutExpired:
            _print_error("npm install Timeout (120s)")
            return False
        except Exception as e:
            _print_error(f"npm install Fehler: {e}")
            return False

    def _run_vsce_package(self) -> bool:
        """Run npx @vscode/vsce package in plugin/ directory.

        Returns True on success, False on failure.
        """
        _print_info("VSIX Build:", "npx @vscode/vsce package --no-dependencies")

        try:
            result = subprocess.run(
                ["npx", "@vscode/vsce", "package", "--no-dependencies"],
                cwd=str(self.plugin_dir),
                capture_output=True,
                text=True,
                timeout=120,
                shell=True,
            )

            # Print vsce output
            if result.stdout.strip():
                for line in result.stdout.strip().split("\n"):
                    _print_info("  vsce:", line.strip())

            if result.returncode != 0:
                _print_error(f"vsce package fehlgeschlagen (exit {result.returncode})")
                if result.stderr.strip():
                    for line in result.stderr.strip().split("\n"):
                        print(f"    {C.RED}{line}{C.RESET}", file=sys.stderr)
                return False

            _print_success("VSIX erfolgreich gebaut")
            return True

        except subprocess.TimeoutExpired:
            _print_error("vsce package Timeout (120s)")
            return False
        except Exception as e:
            _print_error(f"vsce package Fehler: {e}")
            return False

    def _find_vsix_in_plugin(self) -> Path | None:
        """Find the generated .vsix file in plugin/ directory."""
        vsix_files = list(self.plugin_dir.glob("*.vsix"))
        if not vsix_files:
            return None
        # Return the newest one if multiple exist
        vsix_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return vsix_files[0]

    def _move_vsix_to_builds(self, vsix_source: Path, version_str: str, name: str, release_tag: str) -> Path:
        """Move VSIX from plugin/ to .builds/ with proper naming.

        Returns the destination path.
        """
        self.builds_dir.mkdir(parents=True, exist_ok=True)
        dest_name = f"{version_str}-{name}-{release_tag}{self.VSIX_SUFFIX}"
        dest = self.builds_dir / dest_name
        shutil.move(str(vsix_source), str(dest))
        return dest

    def _verify_vsix(self, vsix_path: Path) -> tuple[bool, str]:
        """Verify that VSIX file exists and is valid (> 1KB)."""
        if not vsix_path.exists():
            return False, f"VSIX-Datei existiert nicht: {vsix_path}"

        size = vsix_path.stat().st_size
        if size < self.VSIX_MIN_SIZE:
            return False, f"VSIX-Datei zu klein ({_human_size(size)}): {vsix_path}"

        return True, f"VSIX verifiziert: {vsix_path.name} ({_human_size(size)})"

    def _clean_plugin_vsix(self) -> None:
        """Remove any leftover .vsix files from plugin/ directory."""
        for vsix in self.plugin_dir.glob("*.vsix"):
            try:
                vsix.unlink()
            except Exception:
                pass

    # -- Git Operations -----------------------------------------------------

    def _run_git_command(self, args: list[str], timeout: int = 60) -> tuple[bool, str, str]:
        """Run a git command and return (success, stdout, stderr)."""
        try:
            result = subprocess.run(
                ["git"] + args,
                cwd=str(self.repo_root),
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            return result.returncode == 0, result.stdout.strip(), result.stderr.strip()
        except FileNotFoundError:
            return False, "", "git ist nicht installiert"
        except subprocess.TimeoutExpired:
            return False, "", f"git {args[0]} Timeout ({timeout}s)"
        except Exception as e:
            return False, "", str(e)

    def _git_add_commit_push(
        self,
        comment: str,
        version_str: str,
        name: str,
        release_tag: str,
    ) -> tuple[bool, str]:
        """Stage all changes, commit, and push to origin.

        Returns (success, message). Failure is non-fatal (warning only).
        """
        _print_separator()
        _print_info("Git:", "Starte add + commit + push...")

        # Check git is available
        ok, _, err = self._run_git_command(["--version"])
        if not ok:
            return False, f"Git nicht verfuegbar: {err}"

        # Check remote exists
        ok, remotes, _ = self._run_git_command(["remote"])
        if not ok or not remotes.strip():
            return False, "Kein Git-Remote konfiguriert. Push uebersprungen."

        # Stage all changes
        ok, out, err = self._run_git_command(["add", "."])
        if not ok:
            return False, f"git add fehlgeschlagen: {err}"
        _print_info("  git add:", "alle Aenderungen gestaged")

        # Check if there are staged changes
        ok, diff, _ = self._run_git_command(["diff", "--cached", "--stat"])
        if ok and not diff.strip():
            return False, "Keine Aenderungen zum Committen."

        # Commit
        commit_msg = f"{comment} [v{version_str}-{release_tag}]"
        ok, out, err = self._run_git_command(["commit", "-m", commit_msg])
        if not ok:
            return False, f"git commit fehlgeschlagen: {err}"
        _print_info("  git commit:", commit_msg)

        # Push
        ok, out, err = self._run_git_command(["push", "origin"], timeout=120)
        if not ok:
            return False, f"git push fehlgeschlagen: {err}"
        _print_success("Git push erfolgreich")

        return True, "Git add + commit + push erfolgreich"

    # -- GitHub Release Operations ------------------------------------------

    def _check_gh_installed(self) -> tuple[bool, str]:
        """Check if GitHub CLI is installed and authenticated."""
        try:
            result = subprocess.run(
                ["gh", "--version"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode != 0:
                return False, "gh CLI nicht installiert"
        except FileNotFoundError:
            return False, "gh CLI nicht installiert"
        except Exception as e:
            return False, str(e)

        # Check auth
        try:
            result = subprocess.run(
                ["gh", "auth", "status"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode != 0:
                return False, "gh CLI nicht authentifiziert. Fuehre 'gh auth login' aus."
            return True, "gh CLI bereit"
        except Exception as e:
            return False, str(e)

    def _create_source_zip(self, version_str: str, name: str) -> Path | None:
        """Create a zip archive of all tracked/staged files using git archive."""
        zip_name = f"{version_str}-{name}-source.zip"
        zip_path = self.builds_dir / zip_name
        ok, _, err = self._run_git_command(
            ["archive", "--format=zip", "--output", str(zip_path), "HEAD"],
            timeout=60,
        )
        if ok and zip_path.exists():
            _print_info("  Source-ZIP:", f"{zip_name} ({_human_size(zip_path.stat().st_size)})")
            return zip_path
        # Fallback: if HEAD doesn't exist yet (first commit), use git stash approach
        _print_warn(f"git archive fehlgeschlagen: {err}. Versuche Fallback...")
        return self._create_source_zip_fallback(version_str, name)

    def _create_source_zip_fallback(self, version_str: str, name: str) -> Path | None:
        """Fallback ZIP creation using zipfile module for tracked files."""
        import zipfile
        zip_name = f"{version_str}-{name}-source.zip"
        zip_path = self.builds_dir / zip_name

        # Get list of files that would be committed (non-ignored)
        ok, file_list, _ = self._run_git_command(["ls-files", "--cached", "--others", "--exclude-standard"])
        if not ok or not file_list.strip():
            return None

        try:
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for rel_path in file_list.strip().split("\n"):
                    rel_path = rel_path.strip()
                    if not rel_path:
                        continue
                    abs_path = self.repo_root / rel_path
                    if abs_path.is_file():
                        zf.write(abs_path, rel_path)
            if zip_path.exists():
                _print_info("  Source-ZIP:", f"{zip_name} ({_human_size(zip_path.stat().st_size)})")
                return zip_path
        except Exception as e:
            _print_warn(f"Fallback-ZIP fehlgeschlagen: {e}")
        return None

    def _create_github_release(
        self,
        version_str: str,
        name: str,
        comment: str,
        release_tag: str,
        change_type: str,
        build_number: str,
        vsix_path: Path,
    ) -> tuple[bool, str]:
        """Create a GitHub release with tag, VSIX, and source zip.

        Returns (success, release_url_or_error).
        """
        _print_separator()
        _print_info("GitHub Release:", "Starte Release-Erstellung...")

        # Check gh CLI
        ok, msg = self._check_gh_installed()
        if not ok:
            return False, msg

        tag_safe = build_number.replace(":", ".")
        tag = f"v{tag_safe}"
        title = f"v{build_number}"
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        body = (
            f"## {title}\n\n"
            f"| Detail | Value |\n"
            f"|--------|-------|\n"
            f"| **Version** | {version_str} |\n"
            f"| **Type** | {change_type} |\n"
            f"| **Release** | {release_tag} |\n"
            f"| **Build** | {build_number} |\n"
            f"| **Comment** | {comment} |\n"
            f"| **Timestamp** | {now_str} |\n"
        )

        # Create and push tag
        ok, _, err = self._run_git_command(["tag", "-a", tag, "-m", comment])
        if not ok:
            return False, f"git tag fehlgeschlagen: {err}"
        _print_info("  git tag:", tag)

        ok, _, err = self._run_git_command(["push", "origin", tag], timeout=60)
        if not ok:
            # Try to delete local tag on push failure
            self._run_git_command(["tag", "-d", tag])
            return False, f"git push tag fehlgeschlagen: {err}"
        _print_info("  tag push:", "erfolgreich")

        # Create source zip
        source_zip = self._create_source_zip(version_str, name)

        # Build gh release command
        gh_args = [
            "gh", "release", "create", tag,
            "--title", title,
            "--notes", body,
        ]
        if release_tag == "Normal":
            gh_args.append("--prerelease")

        # Add assets
        gh_args.append(str(vsix_path))
        if source_zip and source_zip.exists():
            gh_args.append(str(source_zip))

        try:
            result = subprocess.run(
                gh_args,
                cwd=str(self.repo_root),
                capture_output=True,
                text=True,
                timeout=120,
            )
            # Clean up source zip
            if source_zip and source_zip.exists():
                try:
                    source_zip.unlink()
                except Exception:
                    pass

            if result.returncode != 0:
                return False, f"gh release create fehlgeschlagen: {result.stderr.strip()}"

            release_url = result.stdout.strip()
            _print_success(f"GitHub Release erstellt: {tag}")
            if release_url:
                _print_info("  Release-URL:", release_url)
            return True, release_url

        except subprocess.TimeoutExpired:
            return False, "gh release create Timeout (120s)"
        except FileNotFoundError:
            return False, "gh CLI nicht gefunden"
        except Exception as e:
            return False, str(e)

    # -- Build-Nummer -------------------------------------------------------

    @staticmethod
    def _build_timestamp() -> str:
        return datetime.now().strftime("%H.%M.%d:%m:%Y")

    def generate_build_number(self, version_str: str, total_version_str: str, name: str, release_tag: str) -> str:
        """Format: {version}.{totalversion}.{HH.MM.DD:MM:YYYY}-{name}-{release_tag}"""
        return f"{version_str}.{total_version_str}.{self._build_timestamp()}-{name}-{release_tag}"

    # -- Hauptlogik ---------------------------------------------------------

    def create_version(
        self,
        change_type: str,
        name: str,
        comment: str,
        release_tag: str,
        allow_bigbump: bool = False,
        dry_run: bool = False,
    ) -> tuple[bool, str]:
        """Create a new versioned VSIX build.

        Ablauf:
            1. Eingabe-Validierung (Typ, Name, Kommentar, Release-Tag)
            2. Lock erwerben
            3. Version berechnen (current + total)
            4. Bisherige VSIX archivieren
            5. package.json Version updaten
            6. VSIX bauen (vsce package)
            7. VSIX nach .builds/ verschieben + umbenennen
            8. VSIX verifizieren
            9. History aktualisieren
           10. Git add + commit + push
           11. GitHub Release erstellen
           12. Lock loesen
        """
        mode_label = "[DRY-RUN] " if dry_run else ""
        original_pkg: dict | None = None

        # -- 1. Validierung Typ ---------------------------------------------
        if change_type not in self.CHANGE_TYPES:
            return False, f"Ungueltiger Typ: {change_type}. Erlaubt: {', '.join(self.CHANGE_TYPES)}"

        if change_type == "UserapprovedBigBump" and not allow_bigbump:
            return False, (
                "UserapprovedBigBump erfordert --allow-bigbump.\n"
                "  Dieser Schutz verhindert versehentliche Major-Releases.\n"
                "  Nur mit ausdruecklicher Nutzerfreigabe verwenden."
            )

        # -- Validierung Name -----------------------------------------------
        ok, result = validate_name(name)
        if not ok:
            return False, result
        name = result

        # -- Validierung Kommentar ------------------------------------------
        ok, result = validate_comment(comment, change_type)
        if not ok:
            return False, result
        comment = result

        # -- Eindeutigkeitspruefung Name ------------------------------------
        if not self.is_name_unique(name):
            return False, (
                f"Versionsname '{name}' existiert bereits.\n"
                f"  Jeder Versionsname darf nur einmal verwendet werden.\n"
                f"  Bitte einen neuen, einzigartigen Namen waehlen."
            )

        # -- Plugin-Verzeichnis pruefen -------------------------------------
        if not self.plugin_dir.exists():
            return False, f"Plugin-Verzeichnis nicht gefunden: {self.plugin_dir}"

        if not self.package_json_path.exists():
            return False, f"package.json nicht gefunden: {self.package_json_path}"

        # -- 2. Lock erwerben -----------------------------------------------
        if not dry_run:
            if not self._lock.acquire():
                return False, "Konnte Lock nicht erwerben. Anderer Build-Vorgang aktiv?"
            atexit.register(self._lock.release)

        try:
            # -- 3. Version berechnen ----------------------------------------
            history = self._load_history()
            cur = Version.from_string(history.get("current_version", "0.0.0"))
            tot = Version.from_string(history.get("total_version", "0.0.0"))

            if change_type == "Fix":
                new_ver = cur.increment_fix()
                new_tot = tot.total_increment_fix()
            elif change_type == "NewFunction":
                new_ver = cur.increment_newfunction()
                new_tot = tot.total_increment_newfunction()
            else:  # UserapprovedBigBump
                new_ver = cur.increment_bigbump()
                new_tot = tot.total_increment_bigbump()

            ver_str = str(new_ver)
            tot_str = str(new_tot)
            build = self.generate_build_number(ver_str, tot_str, name, release_tag)
            now = datetime.now()

            # -- Header -----------------------------------------------------
            _print_header(f"{mode_label}VSIX Build: {ver_str} ({change_type})")

            _print_info("Vorherige Version:", str(cur))
            _print_info("Neue Version:", ver_str)
            _print_info("Total-Version:", f"{tot} -> {tot_str}")
            _print_info("Name:", name)
            _print_info("Typ:", change_type)
            _print_info("Build:", build)
            _print_info("Kommentar:", comment)
            _print_info("Release-Tag:", release_tag)
            _print_info("Zeitpunkt:", now.strftime("%Y-%m-%d %H:%M:%S"))

            vsix_filename = f"{ver_str}-{name}-{release_tag}{self.VSIX_SUFFIX}"
            _print_info("VSIX-Name:", vsix_filename)

            if dry_run:
                _print_separator()
                _print_warn("DRY-RUN: Keine Aenderungen vorgenommen.")
                _print_info("  Wuerde:", f"git add . && git commit && git push")
                _print_info("  Wuerde:", f"GitHub Release v{ver_str}-{release_tag} erstellen")
                return True, ver_str

            # -- 4. Bisherige VSIX archivieren -------------------------------
            _print_separator()
            archived_count = self._archive_current_vsix()
            if archived_count > 0:
                _print_info("Archiviert:", f"{archived_count} VSIX-Datei(en) nach versions/")

            # -- 5. package.json Version updaten -----------------------------
            _print_info("package.json:", f"Version -> {ver_str}")
            original_pkg = self._update_package_json(ver_str)

            # -- Vorbereitung: npm install + vsce check ----------------------
            if not self._run_npm_install():
                self._restore_package_json(original_pkg)
                return False, "npm install fehlgeschlagen"

            if not self._check_vsce_installed():
                _print_warn("vsce nicht gefunden, versuche trotzdem...")

            # -- 6. VSIX bauen -----------------------------------------------
            _print_separator()
            self._clean_plugin_vsix()

            if not self._run_vsce_package():
                self._restore_package_json(original_pkg)
                return False, "VSIX-Build fehlgeschlagen"

            # -- 7. VSIX verschieben -----------------------------------------
            vsix_source = self._find_vsix_in_plugin()
            if not vsix_source:
                self._restore_package_json(original_pkg)
                return False, "Keine .vsix-Datei im plugin/ Verzeichnis nach dem Build gefunden"

            vsix_dest = self._move_vsix_to_builds(vsix_source, ver_str, name, release_tag)
            _print_info("VSIX verschoben:", str(vsix_dest.relative_to(self.repo_root)))

            # -- 8. VSIX verifizieren ----------------------------------------
            ok, verify_msg = self._verify_vsix(vsix_dest)
            if ok:
                _print_success(verify_msg)
            else:
                _print_error(verify_msg)
                return False, f"VSIX-Verifizierung fehlgeschlagen: {verify_msg}"

            vsix_size = vsix_dest.stat().st_size

            # -- 9. History aktualisieren ------------------------------------
            record = {
                "timestamp": now.isoformat(),
                "change_type": change_type,
                "version": ver_str,
                "previous_version": str(cur),
                "total_version": tot_str,
                "previous_total_version": str(tot),
                "name": name,
                "comment": comment,
                "release_tag": release_tag,
                "build_number": build,
                "vsix_file": vsix_dest.name,
                "vsix_size_bytes": vsix_size,
                "vsix_size_human": _human_size(vsix_size),
            }

            history["current_version"] = ver_str
            history["total_version"] = tot_str
            history["records"].append(record)
            self._save_history(history)

            _print_success("versions.json aktualisiert")

            # -- 10. Git add + commit + push ---------------------------------
            git_pushed = False
            git_ok, git_msg = self._git_add_commit_push(comment, ver_str, name, release_tag)
            if git_ok:
                git_pushed = True
            else:
                _print_warn(f"Git push uebersprungen: {git_msg}")

            # -- 11. GitHub Release erstellen --------------------------------
            release_created = False
            release_url = ""
            if git_pushed:
                rel_ok, rel_result = self._create_github_release(
                    ver_str, name, comment, release_tag, change_type, build, vsix_dest,
                )
                if rel_ok:
                    release_created = True
                    release_url = rel_result
                else:
                    _print_warn(f"GitHub Release uebersprungen: {rel_result}")
            else:
                _print_warn("GitHub Release uebersprungen: Git push war nicht erfolgreich.")

            # Update record with git/release info
            record["git_pushed"] = git_pushed
            record["release_created"] = release_created
            if release_url:
                record["release_url"] = release_url
            self._save_history(history)

            # -- Zusammenfassung --------------------------------------------
            _print_separator()
            _print_success(f"Version {ver_str} ({name}) erfolgreich gebaut!")
            _print_info("VSIX:", vsix_dest.name)
            _print_info("Groesse:", _human_size(vsix_size))
            _print_info("Release-Tag:", release_tag)
            _print_info("Git Push:", "Ja" if git_pushed else "Nein")
            _print_info("GitHub Release:", release_url if release_created else "Nein")

            return True, ver_str

        except Exception as e:
            if original_pkg is not None:
                self._restore_package_json(original_pkg)
            _print_error(f"Unerwarteter Fehler: {e}")
            return False, str(e)

        finally:
            if not dry_run:
                self._lock.release()

    # -- Informationsabfragen -----------------------------------------------

    def print_info(self) -> None:
        """Zeigt die aktuelle Versionsinformation an."""
        history = self._load_history()
        _print_header("Aktuelle Version")
        _print_info("Version:", history.get("current_version", "0.0.0"))
        _print_info("Total-Version:", history.get("total_version", "0.0.0"))

        records = history.get("records", [])
        if records:
            last = records[-1]
            _print_info("Letzter Release:", last.get("name", "?"))
            _print_info("Typ:", last.get("change_type", "?"))
            _print_info("Kommentar:", last.get("comment", "?"))
            _print_info("Zeitpunkt:", last.get("timestamp", "?"))
            _print_info("Build:", last.get("build_number", "?"))
            _print_info("VSIX:", last.get("vsix_file", "?"))
            _print_info("Groesse:", last.get("vsix_size_human", "?"))
        else:
            print(f"\n  {C.DIM}Noch keine VSIX-Builds vorhanden.{C.RESET}")

        # Archivierte Versionen zaehlen
        archive_count = 0
        if self.versions_archive_dir.exists():
            archive_count = sum(1 for f in self.versions_archive_dir.iterdir() if f.name.endswith(".vsix"))
        _print_separator()
        _print_info("Archivierte Builds:", str(archive_count))

    def print_list(self, last_n: int = 0) -> None:
        """Zeigt die Versionshistorie als Tabelle an."""
        history = self._load_history()
        records = history.get("records", [])

        if not records:
            _print_header("Build-Historie")
            print(f"\n  {C.DIM}Keine Eintraege vorhanden.{C.RESET}")
            return

        if last_n > 0:
            records = records[-last_n:]

        _print_header(f"Build-Historie ({len(records)} Eintraege)")

        # Spaltenbreiten
        col_ver = 10
        col_tot = 12
        col_typ = 14
        col_name = 14
        col_size = 10
        col_date = 20
        col_comment = 34

        # Header
        print(
            f"  {C.BOLD}"
            f"{'Version':<{col_ver}}"
            f"{'Total':<{col_tot}}"
            f"{'Typ':<{col_typ}}"
            f"{'Name':<{col_name}}"
            f"{'Groesse':<{col_size}}"
            f"{'Datum':<{col_date}}"
            f"{'Kommentar':<{col_comment}}"
            f"{C.RESET}"
        )
        print(f"  {'-' * (col_ver + col_tot + col_typ + col_name + col_size + col_date + col_comment)}")

        type_colors = {
            "Fix": C.YELLOW,
            "NewFunction": C.GREEN,
            "UserapprovedBigBump": C.MAGENTA,
        }
        for rec in records:
            tc = type_colors.get(rec.get("change_type", ""), C.WHITE)
            ts = rec.get("timestamp", "")[:19].replace("T", " ")
            cmt = rec.get("comment", "")
            if len(cmt) > col_comment - 2:
                cmt = cmt[:col_comment - 5] + "..."
            size_str = rec.get("vsix_size_human", "?")
            print(
                f"  {C.WHITE}{rec.get('version', '?'):<{col_ver}}{C.RESET}"
                f"{C.DIM}{rec.get('total_version', '?'):<{col_tot}}{C.RESET}"
                f"{tc}{rec.get('change_type', '?'):<{col_typ}}{C.RESET}"
                f"{C.CYAN}{rec.get('name', '?'):<{col_name}}{C.RESET}"
                f"{C.WHITE}{size_str:<{col_size}}{C.RESET}"
                f"{C.DIM}{ts:<{col_date}}{C.RESET}"
                f"{cmt}"
            )


# ---------------------------------------------------------------------------
#  CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="build.py",
        description="Sudx Copilot Customizations — VSIX Build, Versionierung & History.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Beispiele:
              python build.py -f -b Firefox  -k "FIX: Auth-Bug behoben" -Normal
              python build.py -n -b Pegasus  -k "NEU: Dashboard-Feature" -UserapprovedStable
              python build.py -u -b Zeus     -k "REM: Architektur-Umbau" -Normal --allow-bigbump
              python build.py --list
              python build.py --list --last 5
              python build.py --info
              python build.py -f -b TestRun  -k "FIX: Test" -Normal --dry-run

            Kommentar-Prefixe (Pflicht):
              FIX:   Reparatur / Anpassung bestehender Funktion
              NEU:   Neue Funktionalitaet fuer Nutzer
              REM:   Entfernung / groessere Restrukturierung

            Release-Tags (Pflicht, eines von beiden):
              -Normal                Unstable Release (prerelease)
              -UserapprovedStable    Stable Release

            Versionsschema:
              Fix                    +0.0.1   (Patch)
              NewFunction            +0.1.0   (Minor, Patch-Reset)
              UserapprovedBigBump    +1.0.0   (Major, Minor+Patch-Reset, nur mit --allow-bigbump)
        """),
    )

    # -- Info-Modus ---------------------------------------------------------
    info_group = parser.add_argument_group("Informationen")
    info_group.add_argument(
        "--info",
        action="store_true",
        help="Zeigt aktuelle Versionsinformationen an",
    )
    info_group.add_argument(
        "--list",
        action="store_true",
        help="Zeigt die Build-Historie als Tabelle an",
    )
    info_group.add_argument(
        "--last",
        type=int,
        default=0,
        metavar="N",
        help="Nur die letzten N Eintraege anzeigen (mit --list)",
    )

    # -- Build-Modus --------------------------------------------------------
    ver_group = parser.add_argument_group("Versionierung & Build")
    type_group = ver_group.add_mutually_exclusive_group()
    type_group.add_argument(
        "-f", "--fix",
        action="store_const",
        const="Fix",
        dest="change_type",
        help="Patch-Release (+0.0.1)",
    )
    type_group.add_argument(
        "-n", "--newfunction",
        action="store_const",
        const="NewFunction",
        dest="change_type",
        help="Minor-Release mit neuer Funktion (+0.1.0)",
    )
    type_group.add_argument(
        "-u", "--userapprovedbigbump",
        action="store_const",
        const="UserapprovedBigBump",
        dest="change_type",
        help="Major-Release (+1.0.0) [erfordert --allow-bigbump]",
    )

    ver_group.add_argument(
        "-b", "--bezeichnung",
        dest="name",
        default="",
        help="Eindeutiger Versionsname (z.B. Firefox, Pegasus, Zeus)",
    )

    ver_group.add_argument(
        "-k", "--kommentar",
        dest="comment",
        default="",
        help='Kommentar mit Pflicht-Prefix (z.B. "FIX: Bugfix im Auth-Modul")',
    )

    ver_group.add_argument(
        "--allow-bigbump",
        action="store_true",
        help="Erlaubt UserapprovedBigBump (nur mit ausdruecklicher Nutzerfreigabe)",
    )

    ver_group.add_argument(
        "--dry-run",
        action="store_true",
        help="Simuliert den Vorgang ohne Aenderungen",
    )

    # -- Release-Tag (Pflicht bei Build) ------------------------------------
    tag_group = parser.add_argument_group("Release-Tag (Pflicht bei Build)")
    tag_exclusive = tag_group.add_mutually_exclusive_group()
    tag_exclusive.add_argument(
        "-Normal",
        action="store_const",
        const="Normal",
        dest="release_tag",
        help="Unstable Release (prerelease)",
    )
    tag_exclusive.add_argument(
        "-UserapprovedStable",
        action="store_const",
        const="UserapprovedStable",
        dest="release_tag",
        help="Stable Release",
    )

    return parser.parse_args()


# ---------------------------------------------------------------------------
#  Main
# ---------------------------------------------------------------------------

def main() -> int:
    C.init()
    args = parse_args()
    repo_root = Path(__file__).resolve().parent
    manager = BuildManager(repo_root)

    # -- Info-Modi ----------------------------------------------------------
    if args.info:
        manager.print_info()
        return 0

    if args.list:
        manager.print_list(last_n=args.last)
        return 0

    # -- Build-Modus: Pflichtfelder pruefen ---------------------------------
    if not args.change_type:
        _print_error("Kein Versionstyp angegeben. Verwende -f, -n oder -u.")
        return 1

    if not args.name:
        _print_error("Kein Versionsname angegeben. Verwende -b <Name>.")
        return 1

    if not args.comment:
        _print_error(
            "Kein Kommentar angegeben. Verwende -k \"<PREFIX>: <Beschreibung>\".\n"
            f"  Erlaubte Prefixe: {', '.join(VALID_COMMENT_PREFIXES)}"
        )
        return 1

    if not args.release_tag:
        _print_error(
            "Kein Release-Tag angegeben. Eines von beiden ist Pflicht:\n"
            "  -Normal                Unstable Release (prerelease)\n"
            "  -UserapprovedStable    Stable Release"
        )
        return 1

    # -- Ausfuehrung --------------------------------------------------------
    success, result = manager.create_version(
        change_type=args.change_type,
        name=args.name,
        comment=args.comment,
        release_tag=args.release_tag,
        allow_bigbump=args.allow_bigbump,
        dry_run=args.dry_run,
    )

    if not success:
        _print_error(result)

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
