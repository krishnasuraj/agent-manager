# Claude Code Orchestrator

## What This Is

An Electron desktop app for monitoring and managing multiple Claude Code sessions across git worktrees. The architecture is: **real terminal (xterm.js + node-pty) for UX** + **JSONL session file watcher for state detection** + **a sidebar that surfaces what needs attention**.

Currently at **Stage 1** of the staged build plan (see `project_spec.md`): single-session terminal + JSONL proof of concept. Multi-session, worktree management, and orchestration are planned for later stages.

## Tech Stack

- **Electron** — desktop shell (main + renderer processes)
- **React 19** (Vite via electron-vite) — renderer UI
- **Tailwind CSS v4** — styling (no `tailwind.config.js` — uses `@theme` in CSS)
- **node-pty** — real pseudoterminal for Claude Code sessions (native C++ addon)
- **xterm.js** — terminal rendering in the renderer process
- **chokidar** — file watching for JSONL session files
- **IPC** (contextBridge) — communication between main and renderer
- In-memory state (main process, no database)
- No component library — custom components only

## Architecture (Stage 1)

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

- PTY Manager spawns Claude Code in a real pseudoterminal (interactive mode, full UI)
- JSONL Watcher tails Claude's session JSONL file to derive state (working, idle, needs-input, done, error)
- Terminal Panel renders the PTY output via xterm.js — user interacts with Claude directly
- State Log sidebar shows derived state badge + chronological event log

## How It Works

1. User starts a session (new or resume) from the spawn screen
2. Main process snapshots existing `.jsonl` files in the project dir
3. PTY Manager spawns a login shell, then types `claude` (or `claude --resume <id>`) into it
4. JSONL Watcher detects the NEW `.jsonl` file (not in the snapshot) and locks onto it permanently
5. As Claude works, the watcher tails new lines, parses events, derives state, and sends updates to renderer
6. Terminal Panel shows the full interactive Claude Code UI — user types directly

## State Detection: JSONL Session Files

Claude Code writes a JSONL file per session at:
```
~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
```

The encoded path replaces both `/` and `_` with `-`:
```
/Users/me/my_project → -Users-me-my-project
```

**Note:** Files are directly in the project dir, NOT in a `sessions/` subdirectory.

### State Derivation Logic

State is derived from the **last JSONL event** + **time since last file write**:

| Signal | Derived State |
|--------|---------------|
| Last event has `tool_use` blocks, file still changing | **Working** — actively running tools |
| Last event has `tool_use` blocks, file quiet for 5s+ | **Needs Input** — likely waiting for permission approval |
| Last event is assistant text, file quiet for 5s+ | **Idle** — finished response, waiting for user |
| Last event is `tool_result` | **Working** — processing tool result |
| Last event is user prompt | **Working** — processing prompt |
| Process exit code 0 | **Done** |
| Process exit non-zero | **Error** |

The 5-second stale timer has known limitations: slow Bash commands (npm install, npm test) can take longer than 5s, causing false "needs-input" detection. Per-tool timeouts or PTY output pattern matching could improve this in the future.

### Session File Tracking

Two modes for tying a PTY session to its JSONL file:

1. **New session:** Snapshot existing `.jsonl` files before spawning Claude. After spawn, watch for a NEW file that wasn't in the snapshot. Lock onto it permanently.
2. **Resumed session:** Pass the Claude session UUID directly. Lock onto `<uuid>.jsonl`, skip to end of file, tail new content. Read last 10 events for initial status.

## IPC Protocol (Stage 1)

**Main → Renderer (events):**
| Channel | Payload |
|---------|---------|
| `pty:data` | `(sessionId, data)` — raw PTY output bytes |
| `pty:exit` | `(sessionId, { exitCode, signal })` |
| `jsonl:state` | `(sessionId, { state, summary })` — derived state |
| `jsonl:event` | `(sessionId, { timestamp, icon, label, detail })` — log entry |

**Renderer → Main (fire-and-forget):**
| Channel | Payload |
|---------|---------|
| `pty:write` | `(sessionId, data)` — keyboard input |
| `pty:resize` | `(sessionId, cols, rows)` |

**Renderer → Main (invoke):**
| Channel | Payload |
|---------|---------|
| `session:spawn` | `(sessionId, { cwd?, claudeSessionId? })` |

## File Structure (Current)

```
electron/
  main.js               — Electron entry, window creation, IPC, env scrubbing
  preload.js            — contextBridge exposing electronAPI
  ptyManager.js         — Spawns Claude in real PTY via node-pty
  jsonlWatcher.js       — Watches JSONL session files, derives state
  claudeManager.js      — (v5 leftover) Spawns claude -p, parses NDJSON
  taskStore.js          — (v5 leftover) In-memory task state
  ipc.js                — (v5 leftover) IPC handler registration
  worktree.js           — (v5 leftover) Git worktree create/remove
  seed.js               — (v5 leftover) Auto-creates test tasks
src/
  components/
    TerminalPanel.jsx   — xterm.js terminal with FitAddon + WebLinksAddon
    StateLog.jsx        — Sidebar: state badge + scrolling event log
    ResizableSplit.jsx  — Draggable split layout
    SessionPanel.jsx    — (v5 leftover) Chat UI with markdown rendering
    ToolCallCard.jsx    — (v5 leftover) Collapsible tool call card
    BoardView.jsx       — (v5 leftover) 4-column kanban
    QueueView.jsx       — (v5 leftover) Input-required list
    TaskCard.jsx        — (v5 leftover) Kanban card
    TaskModal.jsx       — (v5 leftover) Create task modal
    TopBar.jsx          — (v5 leftover) App header
  hooks/
    useSession.js       — (v5 leftover) Session event subscription
    useTasks.js         — (v5 leftover) IPC-driven task state
    useTypewriter.js    — (v5 leftover) rAF typewriter animation
  App.jsx               — Spawn screen → split layout (sidebar + terminal)
  main.jsx
  index.css             — Tailwind imports + theme tokens + xterm.css
```

Files marked "(v5 leftover)" are from the previous stream-json architecture and not currently used by Stage 1. They'll be removed or adapted as the project progresses.

## Build System

- **electron-vite 5** — Vite-based build for Electron (main, preload, renderer)
- Config file: `electron.vite.config.js` (NOTE: dot-separated, not hyphen)
- **Tailwind CSS v4** via `@tailwindcss/vite` plugin
- **node-pty** requires `electron-rebuild` (native C++ addon)
- Fonts: **Inter** (sans) + **JetBrains Mono** (mono) loaded via Google Fonts in `index.html`
- Build output: `out/main/`, `out/preload/`, `out/renderer/`

### Running the App

```bash
npm install
npm run rebuild       # electron-rebuild for node-pty (with CXXFLAGS workaround)
npm run dev           # electron-vite dev — opens Electron window with hot reload
npm run build         # electron-vite build — production build to out/
```

### node-pty Rebuild

node-pty is a native C++ addon. On macOS with broken CLT include paths, the rebuild script uses explicit CXXFLAGS:

```bash
CXXFLAGS="-I$(xcrun --show-sdk-path)/usr/include/c++/v1 -isysroot $(xcrun --show-sdk-path)" npx electron-rebuild -f -w node-pty
```

### Custom Theme Tokens (defined in `src/index.css` via `@theme`)

Surfaces: `surface-0` (darkest) through `surface-3`. Borders: `border`, `border-bright`. Text: `text-primary`, `text-secondary`, `text-muted`. Status colors: `status-idle` (gray), `status-running` (blue), `status-guidance` (amber), `status-merged` (green). Use these token names in Tailwind classes (e.g. `bg-surface-2`, `text-status-running`).

## Design Direction

Dark mode only. Developer tool aesthetic — think Linear meets a terminal. Precise, not playful.

- Dark background (`surface-0`: #0a0a0f), muted surfaces, sharp accent colors for status
- Monospace font for branch names, code references, timestamps, terminal content
- Sans-serif for titles and labels
- Generous spacing — the UI should breathe

## Staged Build Plan

See `project_spec.md` for the full plan. Summary:

1. **Stage 1 (current):** Terminal + JSONL proof of concept. Single session.
2. **Stage 2:** Multi-session support. Tab switching, PTY buffering.
3. **Stage 3:** Worktree integration + session spawning UI.
4. **Stage 4:** Orchestration layer. Attention zones, notifications, cross-session awareness.
5. **Stage 5:** Polish. Search, cost tracking, session replay, hooks integration, MCP guidance server.

## Migration History

### v1: Frontend Only
Pure React+Vite frontend with mock data.

### v2: WebSocket Backend
Node.js + Express server with WebSocket. Used `@anthropic-ai/claude-agent-sdk`.

### v3: Electron + Headless Agents
Electron app with `claude -p --output-format stream-json`. Structured event parsing. Read-only terminals.

### v4: Terminal-First
Full interactive terminals via node-pty + xterm.js. Heuristic state detection via ANSI-stripped pattern matching. Unreliable — terminal output fragmentation and ANSI artifacts caused frequent misclassification.

### v5: Stream-JSON
Back to structured JSON events via `claude -p --output-format stream-json --input-format stream-json`. Chat-like session UI. Deterministic state detection from JSON events. No native modules. Multi-turn conversations via stream-json stdin.

### v6: Terminal + JSONL Watching (current)
Best of both worlds: real interactive terminal (node-pty + xterm.js) for UX, JSONL session file watching for reliable state detection. No heuristic pattern matching. User interacts with Claude's native UI directly while the app tracks state from structured JSONL data written to disk.

**Key learnings from previous versions:**
- `electron-vite` 5.x supports Vite 7 (3.x only supports up to Vite 6)
- Config file must be named `electron.vite.config.js` (dot-separated)
- Preload scripts are built as `.mjs` by default — reference `preload.mjs` in BrowserWindow config
- `pointer-events: none` on panels during resize drag prevents canvas from stealing mouse events
- Heuristic ANSI-stripped pattern matching is fundamentally unreliable for state detection
- `claude -p` with stream-json gives deterministic events but loses the interactive terminal experience
- JSONL session files give reliable state without sacrificing terminal interactivity

## Gotchas & Debugging Notes

### Claude nesting detection
The `claude` binary detects when it's spawned inside another Claude Code session via env vars (`CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`). When detected, the process hangs silently (no stdout, no stderr, no exit). Fix: `main.js` scrubs all `CLAUDE*` env vars from `process.env` at startup, and `ptyManager.js` uses `getCleanEnv()` which deletes them from the spawn env.

### JSONL path encoding
Claude encodes the project path by replacing both `/` AND `_` with `-`. For example:
```
/Users/me/my_project → -Users-me-my-project
```
The regex is `/[/_]/g`. Getting this wrong means you watch the wrong directory and never find the session file.

### JSONL files are NOT in a sessions/ subdirectory
Despite what some docs suggest, `.jsonl` files are directly in `~/.claude/projects/<encoded-path>/`, not in a `sessions/` subdirectory.

### Session file detection race condition
When you spawn Claude, the JSONL file doesn't exist immediately. The snapshot-based approach handles this: snapshot before spawn, watch for new files after. The chokidar `add` event fires when the new file appears.

### Wrong session file tracking
If you watch for "any changed JSONL file," the watcher will track whichever session is most active — which might be a different Claude session (like the one you're running this app from). The snapshot diff + permanent file locking approach prevents this.

### Vite watches worktree files
Vite's file watcher sees changes in `.worktrees/` (since `renderer.root: '.'`). When Claude edits files in a worktree, Vite triggers a page reload, destroying all renderer state. Fix: `electron.vite.config.js` ignores `.worktrees/**` in the server watch config.

### Electron main process doesn't inherit shell env vars
macOS Electron apps launched via GUI don't get `$SHELL`, `$USER`, or a full `$PATH`. `ptyManager.js` resolves the `claude` binary via `findClaudeBinary()` which checks `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, then falls back to `which claude`.

### electron-vite hot reload only covers renderer
When modifying `electron/` main process files, you must **stop and restart `npm run dev`**. Renderer changes (`src/`) hot-reload normally.

### Process cleanup on app quit
`main.js` calls `ptyManager.killAll()` and `jsonlWatcher.stopAll()` on the `before-quit` event. Without this, PTY processes become orphans.

### node-pty rebuild on macOS
If CLT C++ headers are not found (`fatal error: 'functional' file not found`), use the CXXFLAGS workaround in the rebuild script. This is a known issue with broken Xcode Command Line Tools installations.

### Permission prompt detection limitations
There is no specific JSONL event for "Claude is waiting for permission approval." The current approach uses a 5-second stale timer: if the last event is a `tool_use` and the file hasn't changed in 5s, assume "needs-input." False positives occur with slow Bash commands. Potential improvements: per-tool timeouts, PTY output pattern matching for known prompt strings.

### Stream-JSON reference (from v5, useful context)
The `--output-format stream-json` from `claude -p` outputs **complete messages** as NDJSON (not Anthropic API streaming format). Requires `--verbose` flag. Input format: `{"type":"user","message":{"role":"user","content":"prompt text"},"session_id":"default","parent_tool_use_id":null}`. With `--dangerously-skip-permissions`, `AskUserQuestion` is auto-denied and the session exits with `permission_denials` in the `result` event.
