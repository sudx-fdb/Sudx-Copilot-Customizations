# Webview UI — User Documentation

## Overview

The Sudx Copilot Customizations Extension provides a terminal-hacker interface as a VS Code Webview. It displays deployment status, controls hooks and agent settings, and offers a log system.

---

## Main View

### Status Display

A blinking dot indicates the current status:
- **Green pulsing**: Deployed and active
- **Gray**: Not deployed
- **Yellow fast pulsing**: Deploy in progress
- **Red**: Error occurred

Additionally displays the number of deployed files and last deploy date.

### Hook Controls

Four hooks can be individually enabled or disabled:
- **Session Context**: Context information for the current session
- **Protect Plans**: Protection of plan files
- **Post Edit**: Post-processing after changes
- **Plan Reminder**: Reminders for open plans

Each hook has a toggle switch. Click or press Space/Enter to toggle.

### Agent Toggle

Enables or disables automatic agent activation.

### Deploy Button

Starts the deploy process. During deployment, a progress bar is displayed. Upon completion, a summary shows the results: Deployed, Skipped, Errors, and Duration.

---

## Log View

Accessible via the Log button in the footer. Displays all deploy entries chronologically.

### Filter

Entries can be filtered by type: All, Success, Error, Skipped. The count of each type is shown as a badge.

### Export

The Export button saves the complete log as a file.

### Navigation

The Back button returns to the main view. Page transitions use smooth crossfade animations.

---

## Settings

### General Settings

- **Deploy Path**: The target path for deployment
- **Auto Activate Agent**: Automatic agent activation on start

### UI Settings

Under "Sudx CC — UI & Appearance" in VS Code Settings:

- **Matrix Rain**: Animated matrix rain background (Default: On)
- **CRT Overlay**: Retro CRT scanline effect (Default: On)
- **Animations**: All UI animations (Default: On)

Changes are applied immediately in the webview.

---

## Accessibility

- All interactive elements are keyboard accessible
- Screen readers receive status announcements on changes
- When "Reduce Motion" is enabled in the OS, all animations are stopped
- High contrast mode removes glows and shadows
- Keyboard navigation: Tab through all elements, Enter/Space to activate

---

## Error Handling

### Connection Errors

When connection to the extension is lost, an error banner appears with a Retry button. The system automatically attempts reconnection up to 3 times with increasing delays.

### Deploy Errors

Errors during deployment are displayed in the log. Status changes to red. After a configurable time, the display automatically resets.

---

## Performance

- Matrix Rain and CRT effects are automatically paused when the tab is not visible
- With many log entries, the DOM is limited to a maximum of 500 entries
- Canvas animations automatically adapt to available frame rate
