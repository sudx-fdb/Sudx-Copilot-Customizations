# Sudx Copilot Customizations

**Deploy and manage Copilot AI agent customization files for your workspace.**

Sudx Copilot Customizations sets up your VS Code project with pre-configured agent definitions, skills, prompts, hooks and instructions for GitHub Copilot — all via a hacker terminal UI.

---

## Features

- **One-Click Deployment** — Deploy all AI configuration files (Agent, Skills, Prompts, Instructions, Hooks) to your workspace
- **4 Automation Hooks** — Session Context, Plan Protection, Post-Edit Reminders, Plan Reminder
- **Hacker Terminal UI** — Matrix Rain, CRT Scanlines, Boot Animation, Particle Effects
- **Statusbar Integration** — Quick access and live deploy status
- **Automatic Backups** — Existing files are backed up before overwriting

---

## Getting Started

### Installation

1. Install VSIX file in VS Code:
   - `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
   - Select VSIX file

2. Extension activates automatically on start.

### Running Deployment

1. **Open Setup Panel:**
   - `Ctrl+Shift+P` → `Sudx CC: Open Setup Panel`
   - Or: Click on **Sudx CC** in the statusbar (bottom right)

2. **Configure Hooks** (optional):
   - Enable/disable desired hooks in the panel

3. **Start Deploy:**
   - Click on `[ EXECUTE DEPLOY ]`
   - Files are deployed to `.github/` in the workspace

---

## Commands

| Command | Description |
|---------|-------------|
| `Sudx CC: Open Setup Panel` | Opens the configuration and deploy panel |
| `Sudx CC: Deploy Configuration` | Starts deployment directly (without panel) |
| `Sudx CC: Reset Configuration` | Resets all settings to default |
| `Sudx CC: Show Log` | Shows deployment log in Output Channel |

---

## What Gets Deployed?

All files are copied to the configured deploy path (default: `.github/`):

| Category | Count | Description |
|----------|-------|-------------|
| **Agent** | 1 | `agents/sudx.agent.md` — Sudx Copilot Customizations agent definition for Copilot Chat |
| **Instructions** | 4 | Planning rules, documentation standards, AI workspace conventions, plan execution guidelines |
| **Prompts** | 21 | Pre-built Copilot prompts (analysis, commit, debug, docs, features, optimization, refactoring, review, testing) |
| **Skills** | 12 | 8 plan skills (full/selective) + 4 documentation skills |
| **Hooks** | 12 | 4 hook configs + 8 scripts (PS1 & SH each) |

---

## Hooks

Hooks are automated scripts executed on specific Copilot events:

| Hook | Event | Description |
|------|-------|-------------|
| **Session Context** | `SessionStart` | Injects project context at Copilot session start |
| **Plan Protection** | `PostToolUse` | Protects plan files from accidental structural changes |
| **Post-Edit** | `PostToolUse` | Reminds about `content.md` updates after file edits |
| **Plan Reminder** | `UserPromptSubmit` | Warns about open, unfinished plans in workspace |

Each hook can be individually toggled in the panel or via settings.

---

## Settings

### General (`Sudx Copilot Customizations`)

| Setting | Default | Description |
|---------|---------|-------------|
| `sudx-ai.hooks` | All active | Toggle individual hooks |
| `sudx-ai.autoActivateAgent` | `true` | Automatically activate agent mode after deployment |
| `sudx-ai.deployPath` | `.github` | Target directory for deployment (relative to workspace) |
| `sudx-ai.showStatusBar` | `true` | Show Sudx CC button in statusbar |
| `sudx-ai.logLevel` | `info` | Log level: `debug`, `info`, `warn`, `error` |

### UI & Appearance (`Sudx CC — UI & Appearance`)

| Setting | Default | Description |
|---------|---------|-------------|
| `sudx-ai.ui.matrixRain` | `true` | Matrix Rain background effect |
| `sudx-ai.ui.crtOverlay` | `true` | CRT Scanline Overlay |
| `sudx-ai.ui.animations` | `true` | Boot animation, particles and transitions |

---

## Panel Overview

![Sudx CC — Main View](../assets/image1.png)

The Setup Panel consists of the following sections:

- **Terminal Logo** — Animated typing simulation with command tooltip
- **Status** — Deployment status (Not Deployed / Deployed / Error) with file count and timestamp
- **Hooks** — 4 toggle switches for automation hooks
- **Agent Activation** — Toggle for automatic agent activation
- **Deploy Button** — Starts deployment with progress display
- **Deployment Log** — Live log with auto-scroll

---

## Deployment Log

![Sudx CC — Deployment Log](../assets/image2.png)

The log view shows all deployed files with timestamps, filter tabs (All / Success / Error / Skipped), and auto-scroll.

---

## Security

- **Automatic Backups** before overwriting (up to 5 per file)
- **Blocked Paths**: `.git`, `node_modules`, `.vscode`, `src`, `dist`, `build`, `out`
- **File Size Limit**: Max. 1 MB per file, 50 MB total
- **Max. 200 files** per deployment
- **3 Retry Attempts** for file operations

---

## Requirements

- VS Code **1.85.0** or newer
- **GitHub Copilot Chat** Extension (for agent activation)

---

## License

MIT







