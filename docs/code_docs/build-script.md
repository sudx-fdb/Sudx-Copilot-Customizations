# Build Script — Technical Code Documentation

## Overview

`build.py` is the VSIX build and version control utility located in the project root. It handles semantic versioning, VSIX packaging via `@vscode/vsce`, and version history management.

---

## Architecture

### File Structure

```
.builds/
├── {version}-{name}-{tag}-sudxai.vsix    ← Current VSIX (always only one)
├── versions/
│   └── {version}-{name}-{tag}-sudxai.vsix ← Archived previous versions
├── versions.json                         ← Version history and metadata
└── .build.lock                           ← Lock file (transient, during build)
```

### VSIX Naming Convention

`{version}-{name}-{release_tag}-sudxai.vsix` — e.g. `1.2.0-Phoenix-Normal-sudxai.vsix`

---

## Classes & Functions

### `Version` (dataclass, frozen)

Semantic version `major.minor.patch` with increment methods.

| Method | Behavior |
|--------|----------|
| `from_string(s)` | Parse `"X.Y.Z"` string via regex |
| `increment_fix()` | `+0.0.1` (patch) |
| `increment_newfunction()` | `+0.1.0` (minor, patch reset) |
| `increment_bigbump()` | `+1.0.0` (major, minor+patch reset) |
| `total_increment_fix()` | `+0.0.1` (no reset) |
| `total_increment_newfunction()` | `+0.1.0` (patch preserved) |
| `total_increment_bigbump()` | `+1.0.0` (minor+patch preserved) |

**Total-Version** accumulates all increments without reset, unlike the display version.

### `_Colors`

ANSI color codes with Windows 10+ compatibility. `init()` enables ANSI via `SetConsoleMode` on Windows, `disable()` strips all codes for non-TTY output.

### `VersionLock`

File-based lock (`PID` + `timestamp`) at `.builds/.build.lock`. Prevents concurrent builds. Auto-released via `atexit`.

### `BuildManager`

Core class orchestrating the build process.

**Constructor paths:**
- `repo_root`, `plugin_dir`, `builds_dir`, `versions_archive_dir`, `history_file`, `lock_file`, `package_json_path`

**Key methods:**

| Method | Purpose |
|--------|---------|
| `_load_history()` / `_save_history()` | JSON I/O for `versions.json` with atomic write (tmp+replace) |
| `is_name_unique(name)` | Case-insensitive uniqueness check against history records |
| `_archive_current_vsix()` | Move all `.vsix` from `.builds/` to `.builds/versions/` |
| `_update_package_json(version)` | Write new version to `plugin/package.json`, return original for rollback |
| `_restore_package_json(data)` | Rollback `package.json` on build failure |
| `_check_vsce_installed()` | Verify `@vscode/vsce` via `npx --version` |
| `_run_npm_install()` | Run `npm install` in `plugin/` if `node_modules/` missing |
| `_run_vsce_package()` | Execute `npx @vscode/vsce package --no-dependencies` |
| `_find_vsix_in_plugin()` | Locate generated `.vsix` in `plugin/` (newest by mtime) |
| `_move_vsix_to_builds()` | Move and rename VSIX to `.builds/` |
| `_verify_vsix(path)` | Check existence and minimum size (>1KB) |
| `_run_git_command(args)` | Run git command with timeout, returns (success, stdout, stderr) |
| `_git_add_commit_push()` | Stage all, commit with build message, push to origin |
| `_check_gh_installed()` | Verify `gh` CLI installed and authenticated |
| `_create_source_zip()` | Create ZIP of tracked files via `git archive` (with fallback) |
| `_create_github_release()` | Create GitHub release with tag, VSIX asset, and source ZIP |
| `generate_build_number()` | Format: `{version}.{totalversion}.{HH.MM.DD:MM:YYYY}-{name}-{tag}` |
| `create_version()` | Full orchestration (10 steps — see below) |
| `print_info()` | Display current version information |
| `print_list(last_n)` | Display version history as colored table |

### `create_version()` — 12-Step Build Pipeline

1. Input validation (type, name, comment, release tag)
2. Acquire lock
3. Calculate version (current + total)
4. Archive existing VSIX to `versions/`
5. Update `plugin/package.json` version field
6. Run `npm install` if needed + check vsce
7. Execute `npx @vscode/vsce package --no-dependencies`
8. Move VSIX from `plugin/` to `.builds/` with proper naming
9. Verify VSIX integrity (exists, >1KB)
10. Update `versions.json` with full record
11. Git add + commit + push to origin (non-fatal)
12. Create GitHub release with tag, VSIX, and source ZIP (non-fatal)

**Error handling:** On build failure at steps 1–9, `package.json` is restored and the lock is released. Git push (10) and GitHub release (11–12) failures are warnings only — the VSIX build is still considered successful.

---

## Validation

### Comment Validation (`validate_comment`)

Mandatory prefixes tied to change types:

| Prefix | For Type | Meaning |
|--------|----------|---------|
| `FIX:` | Fix | Repair or adjustment |
| `NEU:` | NewFunction | New user-facing functionality |
| `REM:` | UserapprovedBigBump | Removal or major restructuring |

Warns if prefix doesn't match the recommended one for the change type but allows it.

### Name Validation (`validate_name`)

- Regex: `^[A-Za-z][A-Za-z0-9_-]*$`
- Length: 2–32 characters
- Must be unique (case-insensitive) across entire history

---

## Version History Record (`versions.json`)

Each record contains:
- `timestamp`, `change_type`, `version`, `previous_version`
- `total_version`, `previous_total_version`
- `name`, `comment`, `release_tag`, `build_number`
- `vsix_file`, `vsix_size_bytes`, `vsix_size_human`
- `git_pushed`, `release_created`, `release_url` (optional)

---

## CLI Arguments

| Argument | Description |
|----------|-------------|
| `-f` / `--fix` | Patch release (+0.0.1) |
| `-n` / `--newfunction` | Minor release (+0.1.0) |
| `-u` / `--userapprovedbigbump` | Major release (+1.0.0, requires `--allow-bigbump`) |
| `-b` / `--bezeichnung` | Unique version name |
| `-k` / `--kommentar` | Comment with mandatory prefix |
| `-Normal` | Unstable release (prerelease) — mandatory, one of two |
| `-UserapprovedStable` | Stable release — mandatory, one of two |
| `--allow-bigbump` | Safety flag for major releases |
| `--dry-run` | Simulate without changes |
| `--info` | Display current version info |
| `--list` | Display build history table |
| `--last N` | Show only last N entries (with `--list`) |

---

## Integration with Webview

`provider.ts` reads the extension version from `context.extension.packageJSON.version` (populated by the build's `package.json` version update) and displays it in the webview panel header.
