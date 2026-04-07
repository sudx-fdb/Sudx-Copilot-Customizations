# Build Script — User Documentation

## Overview

The build script (`build.py`) creates versioned VSIX packages of the Sudx Copilot Customizations extension. It manages semantic versioning, packages the extension, and maintains a complete version history.

---

## Requirements

- Python 3.10+
- Node.js and npm installed
- `@vscode/vsce` (installed automatically as devDependency)
- Git (for automatic push after build)
- GitHub CLI `gh` (optional, for automatic GitHub releases)

---

## Building a New Version

### Basic Syntax

```
python build.py -f|-n|-u -b <NAME> -k "<PREFIX>: <description>" -Normal|-UserapprovedStable
```

### Version Types

| Flag | Type | Version Change | When to use |
|------|------|----------------|-------------|
| `-f` | Fix (Patch) | +0.0.1 | Bug fixes, small adjustments |
| `-n` | NewFunction (Minor) | +0.1.0 | New features for users |
| `-u` | UserapprovedBigBump (Major) | +1.0.0 | Breaking changes, major restructuring |

Major releases require the additional `--allow-bigbump` safety flag.

### Release Tags (Mandatory)

Every build requires exactly one release tag:

| Tag | Meaning |
|-----|--------|
| `-Normal` | Unstable release (marked as prerelease on GitHub) |
| `-UserapprovedStable` | Stable release (full release on GitHub) |

No abbreviations allowed — the full tag name must be typed.

### Comment Prefixes (Mandatory)

Every comment must start with one of these prefixes:

| Prefix | Meaning | Recommended for |
|--------|---------|-----------------|
| `FIX:` | Repair or adjustment | Fix releases |
| `NEU:` | New functionality | NewFunction releases |
| `REM:` | Removal or restructuring | UserapprovedBigBump releases |

### Examples

```bash
# Patch release (bug fix)
python build.py -f -b Firefox -k "FIX: Auth-Bug resolved" -Normal

# Minor release (new feature, stable)
python build.py -n -b Pegasus -k "NEU: Dashboard feature added" -UserapprovedStable

# Major release (breaking change)
python build.py -u -b Zeus -k "REM: Architecture overhaul" -Normal --allow-bigbump

# Dry run (simulate without changes)
python build.py -f -b TestRun -k "FIX: Test" -Normal --dry-run
```

### Version Name Rules

- Must be unique (never reused)
- 2–32 characters
- Letters, digits, underscore, hyphen only
- Must start with a letter

---

## Viewing Version Information

### Current Version

```bash
python build.py --info
```

Shows: current version, total version, last release name, type, comment, timestamp, VSIX size, and archived build count.

### Build History

```bash
python build.py --list
python build.py --list --last 5
```

Displays a colored table with all (or last N) builds including version, type, name, size, date, and comment.

---

## Build Output

After a successful build:

- The VSIX is placed at `.builds/{version}-{name}-{tag}-sudxai.vsix`
- Previous VSIX files are archived to `.builds/versions/`
- `plugin/package.json` is updated with the new version
- `versions.json` records the full build history
- All changes are committed and pushed to git origin
- A GitHub release is created (requires `gh` CLI) with:
  - Git tag: `v{version}-{tag}` (e.g. `v0.7.0-Normal`)
  - VSIX file as release asset
  - Source ZIP of all tracked files
  - Prerelease flag if `-Normal`, full release if `-UserapprovedStable`

Git push and GitHub release are non-fatal — if they fail, the VSIX build is still successful.

The version is also visible in the extension's webview panel header.

---

## Error Recovery

If a build fails at any step, the script automatically:
- Restores `package.json` to its previous version
- Releases the build lock
- Reports the specific failure reason

If a stale lock file remains (e.g. after a crash), manually delete `.builds/.build.lock`.

---

## Versioning System

### Display Version vs. Total Version

- **Display Version**: Resets lower segments on increment (e.g. 1.2.3 → 1.3.0 on minor)
- **Total Version**: Never resets — accumulates all increments for a monotonically increasing number

### Build Number Format

```
{version}.{totalversion}.{HH.MM.DD:MM:YYYY}-{name}-{release_tag}
```

Example: `1.2.0.3.5.1.14.30.06:01:2025-Phoenix-Normal`
