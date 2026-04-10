# Deploy Script — User Documentation

## Overview

The deploy script (`deploy.py`) deploys backend files to a remote server. It only uploads files that have changed (using SHA-256 checksums) and tracks per-file versions. Supports SSH and HTTP transport modes.

---

## Requirements

- Python 3.10+
- For SSH mode: `ssh` and `scp` commands available in PATH, SSH key configured
- For HTTP mode: `requests` library (optional, falls back to `urllib`)

---

## First-Time Setup

On first run, `deploy.py` creates two files:
- `.config` — Your actual connection settings (gitignored, never committed)
- `.config.example` — Template with placeholders (safe to commit)

Edit `.config` with your server details before deploying.

---

## Deploying

### Basic Syntax

```
python deploy.py -ssh|-http [options]
```

### Transport Modes

| Flag | Mode | Authentication |
|------|------|---------------|
| `-ssh` | SSH/SCP | Public key authentication |
| `-http` | HTTP POST | Bearer token (from env variable) |

### Common Commands

```
python deploy.py -ssh                           # Deploy changed files via SSH
python deploy.py -http                          # Deploy changed files via HTTP
python deploy.py -ssh --dry-run                 # Simulate deployment (no changes)
python deploy.py -ssh --force                   # Redeploy ALL files
python deploy.py -ssh --yes                     # Skip confirmation prompt
python deploy.py -ssh -k "FIX: Updated API"    # Deploy with custom comment
python deploy.py --status                       # Show last deployment info
python deploy.py --force-unlock                 # Remove stale deployment lock
python deploy.py -ssh --recover                 # Resume a failed deployment
```

### Options

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be deployed without making changes |
| `--force` | Deploy all files regardless of checksum |
| `--yes` / `-y` | Skip confirmation prompt |
| `-k "comment"` | Custom comment for version log entry |
| `--verbose` | Show detailed debug output |
| `--quiet` / `-q` | Suppress all output except errors |
| `--status` | Show last deployment information |
| `--force-unlock` | Remove a stale deployment lock |
| `--recover` | Resume from a previously failed deployment |
| `--build-version` | Override build version (used by build.py integration) |

---

## Integration with build.py

Deploy can be triggered automatically after a build:

```
python build.py -f -b TestBuild -k "FIX: API fix" -Normal --deploy ssh
python build.py -f -b TestBuild -k "FIX: API fix" -Normal --deploy http
```

When called from `build.py`, deployment runs non-interactively (`--yes`) and the current build version is passed automatically. A deploy failure prints a warning but does not fail the build.

---

## Configuration

The `.config` file contains connection settings in JSON format:

```json
{
  "ssh": {
    "host": "your-server.example.com",
    "user": "deploy-user",
    "port": 22,
    "key_file": "~/.ssh/id_rsa",
    "remote_dir": "/var/www/backend"
  },
  "http": {
    "domain": "https://your-server.example.com",
    "deploy_endpoint": "/api/deploy",
    "health_endpoint": "/health",
    "auth_env_var": "DEPLOY_TOKEN"
  },
  "backup": {
    "enabled": true,
    "remote_backup_dir": "/var/backups/backend"
  },
  "retry": {
    "max_retries": 3,
    "base_delay": 2.0
  }
}
```

---

## What Gets Deployed

- All files under `backend/` that have changed since the last deployment
- New files are added, modified files are updated, deleted files are removed from remote
- Files matching patterns in `backend/.deployignore` are excluded

### .deployignore

Create `backend/.deployignore` with gitignore-style patterns to exclude files:

```
__pycache__/
*.pyc
.env
*.log
```

---

## Version Tracking

Each deployed file is tracked in `.builds/backend.version.json` with:
- Individual file version numbers
- SHA-256 checksums
- Deployment timestamps
- Change comments (auto-generated or custom via `-k`)

---

## Error Recovery

If a deployment is interrupted (network failure, crash):
1. The script saves progress to `.builds/.deploy.state.json`
2. Resume with `python deploy.py -ssh --recover`
3. Already-uploaded files are skipped, only remaining files are uploaded

If `backend.version.json` becomes corrupted, the script automatically attempts to restore from the `.bak` backup file.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Deploy lock exists" | Another deployment is running, or it crashed. Use `--force-unlock` |
| "SSH connection failed" | Check `.config` SSH settings, verify key file exists |
| "HTTP connection failed" | Check server is running, verify domain and endpoints |
| ".config not found" | Run `deploy.py` once to generate the template, then edit it |
| "Permission denied on SSH key" | Check key file permissions (`chmod 600` on Linux/Mac) |

---

## Backend MCP Manager Integration

When a Backend MCP Server Manager is configured in `.config`, the deploy script automatically:

1. **Acquires a deploy lock** on the backend before uploading files
2. **Notifies the backend** that a deployment is starting (logged in the Debug Panel)
3. **Detects affected MCP servers** based on which files changed
4. **Restarts affected servers** via the backend API after files are uploaded
5. **Notifies the backend** when the deployment completes
6. **Releases the deploy lock**

If the backend is not reachable, the deployment proceeds normally without server restarts.

### Backend Configuration in `.config`

```json
{
  "backend_api": {
    "url": "https://your-vps.example.com:8420",
    "token_env_var": "SUDX_API_TOKEN",
    "health_endpoint": "/health",
    "restart_endpoint": "/api/v1/system/restart"
  }
}
```
