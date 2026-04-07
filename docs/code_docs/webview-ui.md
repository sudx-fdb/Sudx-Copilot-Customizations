# Webview UI — Technical Code Documentation

## Architecture Overview

The Webview UI consists of 3 CSS files and 5 JS files, assembled via `provider.ts` as an HTML template and rendered in a VS Code WebviewPanel.

### CSS Stack

| File | Purpose |
|------|---------|
| `plugin/media/styles/main.css` | Design system foundation: CSS custom properties, base resets, CRT overlay, responsive breakpoints, scrollbar, focus/selection, theme layers |
| `plugin/media/styles/animations.css` | All animations: fadeSlideUp, fadeSlideLeft, shake, pulse, skeleton shimmer, matrix-rain glow, progress pulse |
| `plugin/media/styles/components.css` | BEM components: sections, toggles, hook-items, status-dot, log-viewer, deploy-button, tooltips, error-banner |

### JS Stack (Load Order)

| File | Purpose | Global Object |
|------|---------|---------------|
| `plugin/media/scripts/messaging.js` | VS Code API communication, heartbeat, rate-limiting | `window.SudxMessaging` |
| `plugin/media/scripts/animations.js` | Matrix Rain, countUp, stagger, particles, destroyAll | `window.SudxAnimations` |
| `plugin/media/scripts/terminalLogo.js` | Terminal logo typing animation with tooltip | `window.SudxTerminalLogo` |
| `plugin/media/scripts/deploy.js` | Deploy UI: log viewer, progress, auto-reset, export | `window.SudxDeploy` |
| `plugin/media/scripts/main.js` | Boot sequence, page nav, status, config sync, feature flags | IIFE (no export) |

### TypeScript Backend

| File | Purpose |
|------|---------|
| `plugin/src/webview/provider.ts` | WebviewViewProvider — HTML generation (modularized in sub-methods), message routing, nonce caching, UI settings push |
| `plugin/src/webview/messaging.ts` | Server-side message validation, sliding-window RateLimiter, handler duration logging |
| `plugin/src/constants.ts` | Central constants: STRINGS, UI_CONSTANTS, FEATURES, ERROR_STRINGS, ANIMATION_TIMINGS, LOG_CONSTANTS, DEBUG_STRINGS |
| `plugin/src/types.ts` | All TypeScript interfaces: ILogEntry, IRateLimiterConfig, IConnectionHealth, IDeploySummary, IAnimationConfig, IThemeConfig, ILogFilterState, discriminated message unions |
| `plugin/src/config/settings.ts` | Settings manager: OldValue tracking, batch UI read, validateSettings, export/import |
| `plugin/src/statusBar.ts` | Status bar item: Configurable reset timer, progress display, deploy-info tooltip |

---

## Design System

### CSS Custom Properties (main.css `:root`)

**Colors**: `--green-primary` (#00ff41), `--green-dark` (#006622), `--bg-primary` (#000), `--bg-secondary` (#0d0d0d), `--red-primary` (#ff0033), `--yellow-accent` (#ffff00)

**State Colors**: `--state-success`, `--state-error`, `--state-warning`, `--state-info`, `--state-deploying`

**Timing Tokens**: `--cursor-blink-rate` (0.8s), `--timing-pulse-active` (2s), `--timing-pulse-deploy` (1s), `--timing-pulse-error` (1.5s)

**Typography**: Fluid `clamp()`-based, 6 levels (`--font-size-xs` to `--font-size-xxl`), JetBrains Mono / Fira Code / monospace

**Container**: `--container-max-width: clamp(320px, 90vw, 840px)`

**Theme Layer**: `:root[data-theme="dark"]` active, `:root[data-theme="light"]` skeleton prepared

### Responsive Breakpoints

| Breakpoint | Adjustments |
|------------|-------------|
| 768px | Tablet: reduced spacings, glow reduction |
| 520px | Mobile: compact spacings, smaller fonts |
| 320px | Small mobile: minimum sizes |

### Accessibility

- `@media (prefers-contrast: more)`: Glows off, borders enhanced, text-shadow removed
- `@media (prefers-reduced-motion: reduce)`: All animations stopped, CRT scanlines off
- `@media (forced-colors: active)`: Canvas/CanvasText system colors, Matrix/CRT hidden
- WCAG contrast: #00ff41 on #000 = 15.38:1 (AAA)
- Skip navigation link, `role="progressbar"`, `aria-roledescription="toggle switch"`, `role="tooltip"`

---

## provider.ts — HTML Generation

### Modularized Sub-Methods

| Method | Returns |
|--------|---------|
| `resolveMediaUris()` | `{ styles, scripts }` — vscode-webview URIs |
| `getFeatureFlags()` | `IFeatureFlags` from settings |
| `buildMatrixCanvas()` | `<canvas id="matrix-canvas">` |
| `buildErrorBanner()` | Skip nav link + error banner (hidden) |
| `buildLogoSection()` | Terminal logo with typing animation |
| `buildStatusSection()` | Status dot, file count, deploy date |
| `buildHooksSection()` | Hook toggles with `aria-checked`, `title` |
| `buildAgentSection()` | Agent toggle |
| `buildDeploySection()` | Deploy button with progressbar + `aria-*` |
| `buildFooter()` | Reset/Log buttons |
| `buildLogPage()` | Log viewer with filter, export, back |
| `buildScripts()` | `<script defer data-load-order="N">` tags |

### Nonce Caching

`getOrCreateNonce()` generates a nonce per panel instance and caches it in `_panelNonce`. Reset on `dispose()`.

### Message Routing

New handlers: `pushUiSettings` (Webview → Extension: request UI settings), `getLogData` (request log data). Settings change listener automatically pushes UI settings on extension-side changes.

---

## messaging.ts — RateLimiter

### Sliding Window Algorithm

```typescript
class RateLimiter {
  private timestamps: number[] = [];
  private rules: Map<string, { limit: number; windowMs: number }>;

  check(type?: string): { allowed: boolean; retryAfterMs?: number }
  addRule(type: string, config: { limit: number; windowMs: number }): void
}
```

- Global limit: 30 messages / 1000ms
- Deploy rule: 1 deploy / 5000ms
- Old timestamps are cleaned up on each check

### Validation

`validatePayload()` returns `string | null` (specific error message instead of boolean). Hook validation checks against known hook list and provides suggestions.

---

## settings.ts — OldValue Tracking

`_cachedValues: Map<string, unknown>` stores all setting values on initialization. On `notifyChangeHandlers()`, `{ key, oldValue, newValue }` is sent. Batch read for UI settings via `config.get<Record>('ui')`.

New methods: `validateSettings()`, `migrateSettings()`, `exportSettings()`, `importSettings()`.

---

## statusBar.ts — Progress & Deploy Info

`setProgress(percent)` shows "$(sync~spin) Sudx CC: 45%". `setDeployInfo(fileCount, lastDeploy)` enriches tooltip with details. Configurable reset via `UI_CONSTANTS.STATUS_BAR_RESET_MS`.
