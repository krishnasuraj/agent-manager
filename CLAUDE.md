# Claude Code Orchestrator

## What This Is

An Electron desktop app for monitoring and managing multiple Claude Code sessions across git worktrees. The architecture is: **real terminal (xterm.js + node-pty) for UX** + **JSONL session file watcher for state detection** + **a sidebar that surfaces what needs attention**.

Don't fight the terminal, don't reinvent state detection. Claude Code already writes structured JSONL session logs to disk — we watch those for state. The user interacts with Claude's native interactive UI directly.

**Stage 1 is complete.** Currently starting Stage 2 (multi-session support). See `project_spec.md` for the full staged build plan.

## Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Shell | Electron (electron-vite 5, Vite 7) | `electron.vite.config.js` (dot-separated) |
| Frontend | React 19 + Tailwind CSS v4 | `@theme` in CSS, no config file |
| Terminal | xterm.js + @xterm/addon-fit + @xterm/addon-web-links | Renderer process |
| PTY | node-pty | Main process, needs `electron-rebuild` |
| File watching | chokidar | For JSONL session files |
| IPC | contextBridge + ipcRenderer/ipcMain | Standard Electron pattern |
| State | In-memory in main process | No database |
| Fonts | Inter (UI) + JetBrains Mono (terminal) | Google Fonts in index.html |

No component library — custom components only.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Electron Main Process                                  │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐                      │
│  │ PTY Manager │  │ JSONL Watcher│                      │
│  │ (node-pty)  │  │ (chokidar)   │                      │
│  └──────┬──────┘  └──────┬───────┘                      │
│         │                │                              │
│         │  IPC Bridge    │  IPC Bridge                  │
├─────────┼────────────────┼──────────────────────────────┤
│  Preload Script (contextBridge)                         │
├─────────┼────────────────┼──────────────────────────────┤
│  Electron Renderer Process (React)                      │
│                                                         │
│  ┌────────────────┐  ┌──────────────────────────────┐   │
│  │ StateLog       │  │ TerminalPanel                │   │
│  │ (sidebar 30%)  │  │ (xterm.js 70%)               │   │
│  └────────────────┘  └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## How It Works

1. App opens directly to a split layout: sidebar (left 30%) + terminal (right 70%)
2. A login shell is auto-spawned in the terminal — user starts Claude themselves by typing `claude` or `claude --resume <id>`
3. JSONL Watcher watches ALL of `~/.claude/projects/` globally (depth 1) for new or modified `.jsonl` files
4. **New session:** Watcher detects a new `.jsonl` file (not in the pre-spawn snapshot), locks onto it, tails from byte 0
5. **Resumed session:** Watcher detects an existing `.jsonl` file growing past its snapshot size, locks onto it, reads from byte 0 (full history)
6. As Claude works, the watcher parses events, derives state, and sends updates to the sidebar
7. When Claude exits: shell prompt returns → PTY Manager detects it → watcher unlocks → sidebar clears
8. User can start another Claude session — watcher picks it up and sidebar re-activates

## State Detection

### JSONL Session Files

Claude Code writes a JSONL file per session at:
```
~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
```

The encoded path replaces both `/` and `_` with `-`:
```
/Users/me/my_project → -Users-me-my-project
```

**Files are directly in the project dir, NOT in a `sessions/` subdirectory.**

### State Derivation

State is derived from the **last meaningful JSONL event** (skipping noise like `file-history-snapshot`, `progress`, `queue-operation`) + **time since last file write**:

| Signal | Derived State |
|--------|---------------|
| Last event has `tool_use` blocks, file still changing | **Working** |
| Last event has `tool_use` blocks, file quiet for 5s+ | **Needs Input** (likely permission prompt) |
| Last event is assistant text, file quiet for 5s+ | **Idle** |
| Last event is `tool_result` | **Working** |
| Last event is user prompt | **Working** |
| `result` event in JSONL | **Done** |
| Shell prompt returns in PTY | **Done** (fallback) |

Only `user`, `assistant`, `system`, and `result` event types are meaningful for state derivation.

### Hybrid PTY + JSONL Detection

JSONL alone can't detect everything. The PTY Manager scans terminal output for:

- **Thinking spinners:** Pattern `/\*\s+[A-Z][a-z]+[.…]/` matches all Claude thinking formats (`* Orbiting…`, `* Envisioning…`). Overrides idle state to "Working — Thinking..."
- **Permission prompts:** Patterns like `Allow\s+Deny`, `❯\s*(Allow|Yes)`, etc. Immediately sets "Needs Input" without waiting for stale timer.
- **Shell prompt return:** Pattern `/(?:^|\n)\s*(?:.*[$%❯>#])\s*$/` detects Claude exiting back to shell. Triggers session end immediately (no waiting for `result` event — handles Ctrl+C exits).

PTY output is kept in a rolling 4KB buffer, ANSI-stripped before pattern matching. Debounce: 3s for thinking, 2s for permissions, 3s for shell return.

### Session File Tracking

Uses snapshot-based detection with a `Map<filePath, fileSize>`:

1. **Before shell spawn:** Snapshot all `.jsonl` files across all project dirs with their sizes
2. **New file appears:** `chokidar add` event, not in snapshot → new session
3. **Existing file grows:** `chokidar change` event, file size exceeds snapshot → resumed session
4. **Session ends:** `result` event OR shell prompt return → unlock watcher, re-snapshot

## IPC Protocol

**Main → Renderer (events):**
| Channel | Payload |
|---------|---------|
| `pty:data` | `(sessionId, data)` — raw PTY output |
| `pty:exit` | `(sessionId, { exitCode, signal })` |
| `jsonl:state` | `(sessionId, { state, summary })` — derived state |
| `jsonl:event` | `(sessionId, { timestamp, icon, label, detail })` — log entry |
| `jsonl:session-started` | `(sessionId)` — Claude session detected |
| `jsonl:session-ended` | `(sessionId)` — Claude session ended |

**Renderer → Main (fire-and-forget):**
| Channel | Payload |
|---------|---------|
| `pty:write` | `(sessionId, data)` — keyboard input |
| `pty:resize` | `(sessionId, cols, rows)` |

**Renderer → Main (invoke):**
| Channel | Payload |
|---------|---------|
| `session:spawn` | `(sessionId, { cwd? })` |

## File Structure

```
electron/
  main.js               — Electron entry, window creation, IPC wiring, env scrubbing
  preload.js            — contextBridge exposing electronAPI
  ptyManager.js         — PTY lifecycle + output scanning (thinking, permissions, shell return)
  jsonlWatcher.js       — Global JSONL watching, state derivation, session lifecycle
src/
  components/
    TerminalPanel.jsx   — xterm.js terminal with FitAddon + WebLinksAddon
    StateLog.jsx        — Sidebar: state badge + scrolling event log (empty when no session)
    ResizableSplit.jsx  — Draggable split layout
  App.jsx               — Auto-spawns shell, tracks claudeActive state
  main.jsx
  index.css             — Tailwind imports + theme tokens + xterm styles
```

## Build & Run

```bash
npm install
npm run rebuild       # electron-rebuild for node-pty
npm run dev           # electron-vite dev — hot reload for renderer
npm run build         # production build to out/
```

**node-pty rebuild on macOS** — if CLT headers not found:
```bash
CXXFLAGS="-I$(xcrun --show-sdk-path)/usr/include/c++/v1 -isysroot $(xcrun --show-sdk-path)" npx electron-rebuild -f -w node-pty
```

### Custom Theme Tokens (`src/index.css` via `@theme`)

Surfaces: `surface-0` (darkest) through `surface-3`. Borders: `border`, `border-bright`. Text: `text-primary`, `text-secondary`, `text-muted`. Status colors: `status-idle` (gray), `status-running` (blue), `status-guidance` (amber), `status-merged` (green).

## Staged Build Plan

See `project_spec.md` for full details.

1. **Stage 1 (complete):** Single terminal + JSONL watcher. Sidebar with state badge + event log. Session lifecycle (start/exit/resume detection).
2. **Stage 2 (next):** Multi-session. Session manager, tab switching, background PTY buffering via xterm.js SerializeAddon.
3. **Stage 3:** Worktree integration. "New Agent" flow, `git worktree add/remove`, initial prompt injection.
4. **Stage 4:** Orchestration. Attention zones, desktop notifications, cross-session file conflict detection, CI integration.
5. **Stage 5:** Polish. Search, cost tracking, session replay, Claude Code hooks, MCP `requestGuidance` server.

## Design Direction

Dark mode only. Developer tool aesthetic — Linear meets a terminal. Precise, not playful.

- Dark background (`surface-0`: #0a0a0f), muted surfaces, sharp accent colors for status
- Monospace font for branch names, code references, timestamps, terminal content
- Sans-serif for titles and labels
- Generous spacing

## Gotchas & Debugging Notes

### Claude nesting detection
The `claude` binary hangs silently when spawned inside another Claude session. Env vars: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`. Fix: `main.js` scrubs all `CLAUDE*` env vars at startup, `ptyManager.js` uses `getCleanEnv()`.

### JSONL path encoding
Both `/` AND `_` replaced with `-`. Regex: `/[/_]/g`. Getting this wrong = watching the wrong directory.

### JSONL files not in sessions/ subdirectory
Files are directly in `~/.claude/projects/<encoded-path>/`, not in `sessions/`.

### Non-meaningful JSONL events
Events like `file-history-snapshot`, `progress`, `queue-operation` are noise. `deriveState()` walks backward through events to find the last meaningful one (`user`, `assistant`, `system`, `result`).

### Ctrl+C exit doesn't write result event
When user Ctrl+C's out of Claude, no `result` event is written to JSONL. The shell prompt return detection in ptyManager handles this — it fires `notifyShellReturn()` which immediately ends the session.

### Resumed sessions use existing JSONL files
`claude --resume <id>` writes to the existing JSONL file, not a new one. The snapshot stores file sizes, so the watcher detects when an existing file grows past its snapshot size.

### Vite watches worktree files
Vite sees changes in `.worktrees/`. Fix: ignore `.worktrees/**` in `electron.vite.config.js` server watch config.

### Electron main process doesn't inherit shell env on macOS
GUI-launched apps don't get full `$PATH`. `findClaudeBinary()` checks `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, then `which claude`.

### electron-vite hot reload only covers renderer
Main process changes (`electron/`) require restarting `npm run dev`. Renderer changes (`src/`) hot-reload.

### Process cleanup on app quit
`main.js` calls `ptyManager.killAll()` and `jsonlWatcher.stopAll()` on `before-quit`. Without this, PTY processes become orphans.

### node-pty rebuild
Native C++ addon. If `fatal error: 'functional' file not found`, use the CXXFLAGS workaround.

## Stage 1 Implementation Log

### What We Built

Single Electron window with a resizable split: sidebar (30%) showing derived state + event log, terminal (70%) running a real interactive shell via node-pty + xterm.js. The user starts Claude themselves. A JSONL watcher monitors `~/.claude/projects/` for session files and derives state from structured events. When Claude exits, the sidebar clears. When a new session starts (or resumes), the sidebar picks it up.

### Implementation Order

1. **Scaffolded from v5 codebase.** Stripped out `claude -p` / stream-json infrastructure. Kept Electron shell, Vite config, Tailwind theme, ResizableSplit component.

2. **Wired xterm.js + node-pty.** Created `ptyManager.js` (main process) and `TerminalPanel.jsx` (renderer). The PTY spawns a login shell (`$SHELL -l`), not Claude directly. IPC bridge: `pty:data` (main→renderer), `pty:write` (renderer→main), `pty:resize`. Used `@xterm/addon-fit` for auto-sizing and `@xterm/addon-web-links` for clickable URLs.

3. **Built the JSONL watcher.** Created `jsonlWatcher.js`. Watches for `.jsonl` files using chokidar. Tails new lines from the last-read byte position using `fs.createReadStream({ start: bytesRead })`. Parses each line as JSON, derives state, sends events to renderer via IPC.

4. **Built the sidebar.** Created `StateLog.jsx`. State badge at top (colored dot + label), scrolling event log below. Auto-scrolls to bottom unless user has scrolled up. Events show icon + label + detail + timestamp.

5. **Added spawn screen with project picker.** Initially the app started with a screen to pick a directory and optionally resume a session. Later removed — went straight to a bare shell instead.

6. **Added permission prompt detection via PTY scanning.** JSONL has no specific event for "waiting for permission." Added ANSI stripping + pattern matching on PTY output to detect permission prompts instantly.

7. **Added thinking spinner detection.** During extended thinking, Claude doesn't write to JSONL, so the stale timer fires and shows idle. Added PTY-based detection for thinking spinners.

8. **Removed spawn screen.** Changed to auto-spawn a shell on mount. User types `claude` themselves. Separated `ptySessionId` (terminal connection, always set) from `claudeActive` (JSONL tracking, toggled by session lifecycle).

9. **Added session lifecycle.** `result` event in JSONL → session ended → sidebar clears. New `.jsonl` file detected → session started → sidebar activates. Watcher unlocks and re-snapshots between sessions.

10. **Made watcher global.** Changed from watching a single project dir to watching all of `~/.claude/projects/` with `depth: 1`. This way it picks up sessions regardless of which directory the user `cd`s to.

11. **Added shell return detection.** PTY Manager detects when the shell prompt returns after Claude was running (Ctrl+C exit). Immediately ends the session without waiting for a `result` event.

12. **Added resume support.** Changed snapshot from `Set<path>` to `Map<path, size>`. When an existing JSONL file grows past its snapshot size, the watcher locks onto it and reads from byte 0, loading full history into the sidebar.

### Bugs & Challenges

#### JSONL filename ≠ session ID
The JSONL filename UUID and the `sessionId` field inside the file are different values. Resumed sessions can create new files with different UUIDs. Tried matching by session ID inside the file — too fragile. Solution: snapshot-based detection. Don't care about the filename — just detect new or growing files.

#### Status always showing "Idle"
`deriveState()` was looking at the last event in the array, but events like `file-history-snapshot`, `progress`, and `queue-operation` were being appended. These aren't meaningful conversation events, so the last event was always noise → always idle. Fix: added `MEANINGFUL_TYPES` set (`user`, `assistant`, `system`, `result`) and walk backward to find the last meaningful event.

#### Thinking spinners showing as "Idle"
During extended thinking (10-30s), Claude shows spinners like `* Orbiting…`, `* Hashing…`, `* Envisioning…` but doesn't write to JSONL. The 5-second stale timer fires and the state flips to idle. First attempt: enumerate all spinner words individually — there are dozens and new ones get added. Second attempt: track all PTY byte activity as "working" — caused false positives because the user's cursor blinking in the input line registers as PTY activity. Final solution: single regex `/\*\s+[A-Z][a-z]+[.…]/` that matches the universal `* Word...` format all Claude spinners use. Clean, no false positives.

#### Shell not active after removing spawn screen
When removing the spawn screen and auto-spawning, forgot to call `setPtySessionId()` so the TerminalPanel never received a session ID to listen for PTY data. Terminal showed a cursor but no shell prompt. Fix: separated `ptySessionId` (always set after spawn) from `claudeActive` (toggled by JSONL watcher). TerminalPanel always gets `ptySessionId`, StateLog gets `sessionId={claudeActive ? ptySessionId : null}`.

#### Watcher watching wrong directory
User `cd`'d to `~/Documents/personal_projects/tests` and started Claude there. Watcher was watching `~/.claude/projects/-Users-...-agent-manager/` (the app's own project dir). Session in `tests` created a JSONL file in a different project dir that wasn't being watched. Fix: changed watcher to watch ALL of `~/.claude/projects/` with chokidar `depth: 1`. Snapshot scans all project subdirs globally.

#### Vite hot reload destroying state
When developing the app and Claude edits files in the same project directory, Vite's file watcher triggers a page reload, destroying all renderer state. The app exits to a blank screen. This is inherent when developing the app from within the app's own directory. Workaround: develop from a different directory, or accept the reload. For worktrees specifically, `.worktrees/**` is ignored in the Vite watch config.

#### Ctrl+C exit not clearing sidebar
When user presses Ctrl+C twice to exit Claude, no `result` event is written to JSONL. The watcher stayed locked, sidebar stayed visible showing stale state. Fix: added shell prompt return detection in ptyManager — when the shell prompt (`$`, `%`, `❯`, `>`, `#`) appears after Claude was running, fire `notifyShellReturn()` which immediately ends the session. Also added a 30-second fallback unlock timer as a safety net.

#### Sidebar not clearing visually on session end
The `claudeActive` flag was being set to `false` correctly, but StateLog still rendered the state badge and "Waiting for JSONL events..." placeholder when `sessionId` was null. It didn't look "wiped." Fix: added an early return in StateLog that renders a centered "No active Claude session" message when `sessionId` is null.

#### Resumed sessions not loading history
`claude --resume <id>` writes to an existing JSONL file. The watcher only looked for NEW files (chokidar `add` event + snapshot diff). Existing files were in the snapshot, so `change` events were ignored when unlocked. Fix: changed snapshot from `Set<path>` to `Map<path, fileSize>`. On `change` event when unlocked, check if the file grew past its snapshot size. If so, lock onto it and read from byte 0 to load full history.

### What We Validated (Stage 1 Kill Criteria)

- **chokidar reliably fires** on macOS (FSEvents) when Claude writes to JSONL files. Sub-100ms latency.
- **State transitions appear within 1-2 seconds** of Claude acting. Good enough for a dashboard.
- **Working vs idle vs needs-input** are distinguishable, though the 5s stale timer is a rough heuristic. Hybrid PTY scanning fills the gaps for thinking and permission prompts.
- **Terminal works perfectly.** Full interactive Claude UI: colors, spinners, permission prompts, everything. User types directly.
- **Session lifecycle works.** Start Claude → sidebar activates. Exit Claude → sidebar clears. Start again → sidebar re-activates. Resume → full history loads.

## Migration History

| Version | Approach | Why it failed / changed |
|---------|----------|------------------------|
| v1 | Frontend only, mock data | No backend |
| v2 | WebSocket + Express | Over-engineered |
| v3 | Electron + headless `claude -p` + stream-json | Lost interactive terminal |
| v4 | Terminal-first (node-pty + xterm.js) | Heuristic ANSI pattern matching unreliable |
| v5 | Stream-JSON chat UI (`claude -p --output-format stream-json`) | No interactive terminal, format not granular enough |
| v6 | Terminal + JSONL watching (current) | Best of both: real terminal UX + reliable structured state |
