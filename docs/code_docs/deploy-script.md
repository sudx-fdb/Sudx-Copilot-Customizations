# Deploy Script — Technical Code Documentation

## Overview

`deploy.py` is a standalone backend deployment tool located in the project root. It handles SHA-256 checksum-based differential deployment, per-file versioning, SSH/HTTP transport, and crash recovery. Can be invoked standalone or via `build.py --deploy`.

---

## Architecture

### File Structure

```
.builds/
├── backend.version.json          ← Per-file version tracking for backend/
├── backend.version.json.bak      ← Automatic backup before writes
├── .deploy.lock                  ← JSON lock file (transient, during deploy)
├── .deploy.state.json            ← Crash recovery state (in-progress deploys)
└── deploy.log                    ← Persistent log file (rotated at 5MB)

.config                            ← Connection settings (SSH/HTTP), gitignored
.config.example                    ← Template with placeholders for version control
backend/
└── .deployignore                  ← Gitignore-style patterns for deploy exclusion
```

---

## Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `SCRIPT_VERSION` | `"1.0.0"` | Deploy script version |
| `CHECKSUM_CHUNK_SIZE` | `8192` | Bytes per read when hashing files |
| `LOCK_STALE_SECONDS` | `1800` | Lock considered stale after 30 min |
| `LOG_MAX_BYTES` | `5242880` | Log rotation threshold (5 MB) |
| `SSH_TIMEOUT` | `30` | Default SSH command timeout (seconds) |
| `HTTP_TIMEOUT` | `60` | Default HTTP request timeout (seconds) |
| `MAX_RETRIES` | `3` | Network retry attempts |
| `RETRY_BASE_DELAY` | `2.0` | Exponential backoff base (seconds) |

---

## Classes & Functions

### `_Colors`

ANSI color codes with Windows fallback. Mirrors `build.py`'s color system.

### `DeployLogger`

Structured logging with colored console output, optional file logging, verbose/quiet modes.

| Method | Behavior |
|--------|----------|
| `debug(msg)` | Only in verbose mode, with timestamp |
| `info(msg)` | Normal output with `ℹ` prefix |
| `success(msg)` | Green checkmark `✓` prefix |
| `warn(msg)` | Yellow `⚠` prefix, always shown |
| `error(msg)` | Red `✗` prefix, always shown |
| `progress(current, total, msg)` | `[3/7] msg...` format |

### `DeployError` Hierarchy

| Exception | Code | Purpose |
|-----------|------|---------|
| `DeployError` | base | Base exception with error code + suggested fix |
| `ConfigError` | `E_CONFIG` | Configuration file issues |
| `ConnectionError_` | `E_CONN` | SSH/HTTP connection failures |
| `TransferError` | `E_TRANSFER` | File upload failures |
| `VersionError_` | `E_VERSION` | Version JSON issues |
| `LockError_` | `E_LOCK` | Deployment lock conflicts |

### `ConfigManager`

Loads and validates `.config` JSON. Auto-generates template on first run.

| Method | Behavior |
|--------|----------|
| `load()` | Read `.config`, parse JSON, validate all fields |
| `_generate_template()` | Create `.config` + `.config.example` |
| `_validate()` | Check required fields, SSH key existence, port ranges |
| `get(section, key)` | Access config values by section |

### `ChecksumEngine`

SHA-256 based file diffing for `backend/` directory.

| Method | Behavior |
|--------|----------|
| `compute_sha256(filepath)` | Chunked hash computation |
| `scan_backend_files()` | Recursive scan respecting `.deployignore` |
| `load_previous_checksums()` | Read from `backend.version.json` entries |
| `save_checksums(checksums)` | Atomic JSON write with backup |
| `compute_diff(current, previous)` | Returns `added`, `modified`, `deleted` sets |

### `VersionManager`

Per-file version tracking via `backend.version.json`.

| Method | Behavior |
|--------|----------|
| `load()` | Parse version JSON with corrupt-file recovery |
| `create_backup()` | Copy to `.bak` before modifications |
| `get_entry(filepath)` | Lookup by relative path |
| `update_entry(filepath, sha256, comment)` | Bump version, add log entry |
| `add_new_file(filepath, sha256, build_version)` | Create entry at `0.0.1` |
| `mark_deleted(filepath)` | Set `deleted: true` with timestamp |
| `save()` | Atomic write with temp file + rename |
| `get_current_build_version()` | Read from `versions.json` |

### `SSHTransport`

SSH/SCP transport layer using system `ssh` and `scp` commands.

| Method | Behavior |
|--------|----------|
| `_validate_key_file()` | Check key exists, warn on insecure permissions |
| `_run_with_retry(cmd)` | Exponential backoff retry wrapper |
| `test_connection()` | `ssh echo test` connectivity check |
| `execute_command(cmd)` | Remote command execution with timeout |
| `ensure_remote_dirs(dirs)` | `mkdir -p` for remote directories |
| `upload_file(local, remote)` | `scp` with retry and progress |
| `upload_batch(files)` | Sequential batch upload with progress |
| `verify_remote_file(path, sha)` | Remote `sha256sum` integrity check |
| `create_backup(remote_dir)` | `cp -r` timestamped remote backup |
| `restore_backup(backup, target)` | Restore from remote backup |
| `delete_remote_file(path)` | Remote `rm` for deleted files |

### `HTTPTransport`

HTTP POST transport layer using `requests` library (optional) or `urllib`.

| Method | Behavior |
|--------|----------|
| `test_connection()` | GET `/health` endpoint check |
| `_make_request(method, url, **kwargs)` | Retry wrapper with auth header |
| `upload_file(local, remote)` | Multipart POST with auth token |
| `upload_batch(files)` | Sequential HTTP upload |
| `verify_remote_file(path, sha)` | GET `/verify` endpoint check |
| `create_backup()` | POST `/backup` endpoint |
| `restore_backup(backup_id)` | POST `/restore` endpoint |
| `delete_remote_file(path)` | DELETE endpoint |

### `DeployState`

Crash recovery via `.deploy.state.json`.

| Method | Behavior |
|--------|----------|
| `save(repo_root, log)` | Atomic write of in-progress state |
| `load(repo_root, log)` | Class method, returns `Optional[DeployState]` |
| `clear(repo_root, log)` | Delete state file after successful deploy |

### `DeployLock`

JSON-based deployment lock with stale detection.

| Method | Behavior |
|--------|----------|
| `acquire()` | Create lock file, check for stale locks |
| `release()` | Remove lock file |
| `force_unlock()` | Remove lock regardless of owner |
| `is_locked()` | Check lock existence and staleness |

### `DeployManager`

Main orchestrator coordinating all components.

| Method | Behavior |
|--------|----------|
| `deploy(transport, args)` | Full deployment pipeline |
| `show_status()` | Print last deployment info |
| `_recover_deployment()` | Resume from saved state |

### `parse_args()`

Argparse CLI matching `build.py` style with transport group, action flags, and options.

### `main()`

Entry point: init colors → parse args → dispatch action → return exit code. Global exception handler with state preservation.

---

### `BackendIntegration`

Handles all MCP backend API interaction for deploy hooks. Uses `urllib.request` (no external dependencies).

| Method | Behavior |
|--------|----------|
| `_api_request(method, endpoint, body, timeout)` | Authenticated HTTP request to backend API with error handling |
| `is_reachable()` | Check backend health endpoint, returns True if healthy |
| `restart_backend_http()` | Restart backend via HTTP API (zero-downtime preferred) |
| `restart_backend_ssh(ssh_host, ssh_user, ssh_port, ssh_key, remote_base)` | Restart backend via SSH command (fallback) |
| `acquire_deploy_lock()` | Acquire remote deploy lock via API |
| `release_deploy_lock()` | Release remote deploy lock via API |
| `notify_deploy_start(files)` | Emit deploy start event to backend logger |
| `notify_deploy_complete(summary)` | Emit deploy complete event to backend logger |
| `get_server_status()` | Get status of all managed MCP servers |

### `_FILE_MCP_MAPPING`

Static mapping from file paths to MCP server names. When deployed files match these patterns, the affected MCP server is automatically restarted:

```python
_FILE_MCP_MAPPING = {
    "mcp_services/playwright/": "playwright",
    "mcp_services/crawl4ai/": "crawl4ai",
    ...
}
```

### Deploy Flow with Backend Integration

1. Check if backend is reachable (`BackendIntegration.is_reachable()`)
2. Acquire deploy lock (`acquire_deploy_lock()`)
3. Notify deploy start (`notify_deploy_start()`)
4. Upload changed files (existing SSH/HTTP transport)
5. Determine affected MCP servers via `_FILE_MCP_MAPPING`
6. Restart affected servers via HTTP (SSH fallback)
7. Notify deploy complete (`notify_deploy_complete()`)
8. Release deploy lock (`release_deploy_lock()`)

---

## build.py Integration

`build.py` accepts `--deploy ssh|http` flag. After successful VSIX build, it spawns `deploy.py` as a subprocess with `--yes` (non-interactive) and `--build-version` (current version string). Deploy failure prints a warning but does not fail the build.

---

## Security

- `.config` excluded from git via `.*` pattern in `.gitignore`
- `_sanitize_config_for_log()` strips SSH keys, tokens, passwords before logging
- SSH key permission check warns on world-readable files
- HTTP auth via bearer token from environment variable
- No plaintext credentials in config (env vars for tokens)
