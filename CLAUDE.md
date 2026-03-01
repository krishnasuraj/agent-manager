# Stream-JSON Claude Code Orchestrator

## What This Is

An Electron desktop app for monitoring and managing multiple Claude Code sessions across git worktrees. Uses `claude -p --output-format stream-json --input-format stream-json` for structured, deterministic state detection. The UI is a chat-like session panel with streaming text and tool call cards, alongside a kanban board that tracks agent status.

## Tech Stack

- **Electron** — desktop shell (main + renderer processes)
- **React 19** (Vite via electron-vite) — renderer UI
- **Tailwind CSS v4** — styling (no `tailwind.config.js` — uses `@theme` in CSS)
- **child_process.spawn** — spawns `claude -p` per task (no native modules)
- **IPC** (contextBridge) — communication between main and renderer
- In-memory state (main process, no database)
- No component library — custom components only

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Electron Main Process                               │
│                                                      │
│  taskStore.js ─── claudeManager.js ─── child_process │
│       │                │                   │         │
│       │          NDJSON parsing             │ spawn   │
│       │          (structured events)       │ per task│
│       │                │                   │         │
│       └──── IPC (contextBridge) ───────────┘         │
│                      │                               │
├──────────────────────┤───────────────────────────────┤
│  Preload Script      │                               │
│  electronAPI bridge  │                               │
├──────────────────────┤───────────────────────────────┤
│  Renderer Process (React)                            │
│                                                      │
│  App.jsx ─── ResizableSplit                          │
│     │          ├── BoardView / QueueView (left)      │
│     │          └── SessionPanel (right, chat UI)     │
│     └── TaskModal                                    │
│                                                      │
└──────────────────────────────────────────────────────┘
```

- Main process owns all task state (in-memory)
- Renderer is a thin client that receives state via IPC
- Each task = one `claude -p` process in an isolated git worktree
- User types prompts in a text input, Claude responds with streaming text + tool call cards
- Structured JSON events flow from `claude -p` stdout → claudeManager → IPC → renderer
- Status is deterministic from JSON events (no heuristic pattern matching)

## Interaction Model

The session panel is a chat-like UI. The user sends prompts via a text input, and Claude's responses stream in as text blocks and collapsible tool call cards. This replaces the previous interactive terminal approach.

1. **Isolation** — each task gets its own git worktree
2. **Monitoring** — kanban board tracks agent state from structured JSON events
3. **Multiplexing** — manage multiple concurrent Claude sessions

## Deterministic State Detection

Status is derived from stream-json events — no heuristic pattern matching:

| Event | Status |
|-------|--------|
| `message_start` (assistant) | `in-progress` |
| `content_block_start` | `in-progress` |
| `message_stop` | `idle` |
| process exit(0) | `completed` |
| process exit(non-zero) / error | `completed` + error |

## Core Concepts

### Task

A task is a named Claude session in an isolated git worktree. Every task has:

- `id` — unique identifier
- `title` — short human-readable name
- `status` — one of four statuses (derived from JSON events)
- `branch` — the git branch / worktree name (`feat/<slug>`)
- `baseBranch` — the branch it was forked from
- `worktreePath` — absolute path to the worktree directory
- `messages` — array of `{role, content, toolCalls?, timestamp}`
- `tokenUsage` — `{input, output}` token counts
- `error` — error string if session failed
- `createdAt` / `updatedAt` — timestamps

### Statuses

Four columns in the kanban, four possible states:

1. **Idle** — session started but waiting for user prompt, or Claude finished a response
2. **In Progress** — Claude is actively working (streaming text or executing tools)
3. **Input Required** — reserved for future use (e.g., Claude asking clarifying questions)
4. **Completed** — Claude session ended (process exited)

Status transitions are automatic (driven by JSON events), not manual.

## Two Views + Session Panel

### 1. Board View (Kanban)
Four columns, one per status. Cards show title, branch, status dot, time-ago. Clicking any card opens its session panel.

### 2. Issues View (List)
Filtered to `input-required` only. FIFO ordering. Clicking opens session panel.

### 3. Session Panel
Right side of a resizable split. Chat-like UI with:
- Header: status dot, title, branch, abort button (when streaming), close button
- Message list: user messages, assistant text, tool call cards, streaming text with cursor
- Input bar: textarea + send button, disabled while streaming

## Layout

Resizable split: kanban/issues on left, session panel on right. Draggable divider. Default 55/45 split. Min widths enforced (380px left, 300px right).

## File Structure

```
electron/
  main.js               — Electron entry, window creation, module init, env scrubbing
  preload.js            — contextBridge exposing electronAPI
  taskStore.js          — In-memory task state with change listeners
  claudeManager.js      — Spawns claude -p, parses NDJSON, maps events→status
  worktree.js           — Git worktree create/remove per task
  ipc.js                — IPC handler registration
  seed.js               — Auto-creates test tasks when --seed flag is passed
src/
  components/
    TopBar.jsx          — App header, view toggle, queue badge, new task button
    BoardView.jsx       — 4-column kanban
    QueueView.jsx       — Input-required filtered list
    TaskCard.jsx        — Clickable card (no action buttons)
    TaskModal.jsx       — Create task: title + base branch + initial prompt
    SessionPanel.jsx    — Chat UI: message list + input bar
    ToolCallCard.jsx    — Collapsible card for tool calls
    ResizableSplit.jsx  — Draggable split layout
  hooks/
    useTasks.js         — IPC-driven task state
    useSession.js       — Subscribes to session events, manages streaming state
  App.jsx
  main.jsx
  index.css             — tailwind imports + theme tokens
```

## Build System

- **electron-vite 5** — Vite-based build for Electron (main, preload, renderer)
- Config file: `electron.vite.config.js` (NOTE: dot-separated, not hyphen)
- **Tailwind CSS v4** via `@tailwindcss/vite` plugin
- Fonts: **Inter** (sans) + **JetBrains Mono** (mono) loaded via Google Fonts in `index.html`
- No native modules — no `electron-rebuild` needed
- Build output: `out/main/`, `out/preload/`, `out/renderer/`

### Running the App

```bash
npm install
npm run dev       # electron-vite dev — opens Electron window with hot reload
npm run dev:seed  # same as dev but auto-creates 3 test tasks on startup
npm run build     # electron-vite build — production build to out/
```

### Custom Theme Tokens (defined in `src/index.css` via `@theme`)

Surfaces: `surface-0` (darkest) through `surface-3`. Borders: `border`, `border-bright`. Text: `text-primary`, `text-secondary`, `text-muted`. Status colors: `status-idle` (gray), `status-running` (blue), `status-guidance` (amber), `status-merged` (green). Use these token names in Tailwind classes (e.g. `bg-surface-2`, `text-status-running`).

## IPC Protocol

**Main → Renderer (events):**
| Channel | When |
|---------|------|
| `task:created` | New task added |
| `task:updated` | Any task field changes |
| `task:deleted` | Task removed |
| `session:event:<taskId>` | Parsed JSON event from claude -p for a specific task |

**Renderer → Main (invoke):**
| Channel | Args |
|---------|------|
| `tasks:getAll` | — |
| `tasks:create` | `{ title, baseBranch, prompt }` |
| `tasks:delete` | `taskId` |
| `session:send-message` | `{ taskId, text }` |

**Renderer → Main (fire-and-forget):**
| Channel | Args |
|---------|------|
| `session:abort` | `taskId` |

## Permission Model

Uses `--dangerously-skip-permissions` since tasks run in isolated worktrees. Can later add per-task `--allowedTools` configuration.

## Design Direction

Dark mode only. Developer tool aesthetic — think Linear meets a terminal. Precise, not playful.

- Dark background (`surface-0`: #0a0a0f), muted surfaces, sharp accent colors for status
- Monospace font for branch names, code references, timestamps, message content
- Sans-serif for titles and descriptions
- In-progress cards get animated border glow
- Session panel matches app background seamlessly
- Generous spacing — the board should breathe

## What We Are NOT Building Yet

- Git worktree cleanup on task delete
- Persistent storage / database
- Drag and drop on the kanban
- Multi-repo support
- Electron packaging / distribution
- Dynamic branch list in task creation modal
- Per-task `--allowedTools` configuration
- Manual status override

## Migration History

### v1: Frontend Only
Pure React+Vite frontend with mock data.

### v2: WebSocket Backend
Node.js + Express server with WebSocket. Used `@anthropic-ai/claude-agent-sdk`.

### v3: Electron + Headless Agents
Electron app with `claude -p --output-format stream-json`. Structured event parsing. Read-only terminals.

### v4: Terminal-First
Full interactive terminals via node-pty + xterm.js. User runs `claude` directly. Heuristic state detection via ANSI-stripped pattern matching. Unreliable — terminal output fragmentation and ANSI artifacts caused frequent misclassification.

### v5: Stream-JSON (current)
Back to structured JSON events via `claude -p --output-format stream-json --input-format stream-json`. Chat-like session UI replaces interactive terminal. Deterministic state detection from JSON events. No native modules (node-pty removed). Multi-turn conversations via stream-json stdin.

**Key learnings from previous versions:**
- `electron-vite` 5.x supports Vite 7 (3.x only supports up to Vite 6)
- Config file must be named `electron.vite.config.js` (dot-separated)
- Preload scripts are built as `.mjs` by default — reference `preload.mjs` in BrowserWindow config
- `pointer-events: none` on panels during resize drag is essential to prevent canvas from stealing mouse events
- Heuristic ANSI-stripped pattern matching is fundamentally unreliable for state detection
- `claude -p` with stream-json gives deterministic, structured events

## Gotchas & Debugging Notes

### Claude nesting detection
The `claude` binary detects when it's spawned inside another Claude Code session via env vars (`CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`). When detected, the process hangs silently (no stdout, no stderr, no exit). Fix: `main.js` scrubs all `CLAUDE*` env vars from `process.env` at startup, and `claudeManager.js` uses `getCleanEnv()` which deletes them from the spawn env. This allows running the app from inside a Claude Code terminal.

### Stream-JSON message format
The `--output-format stream-json` from `claude -p` does **NOT** use the Anthropic API streaming format (no `message_start`, `content_block_delta`, etc.). Instead it outputs **complete messages** as NDJSON:
- `{"type":"assistant","message":{"role":"assistant","content":[...]}}`
- `{"type":"user","message":{"role":"user","content":[{"type":"tool_result",...}]}}`
- `{"type":"result","subtype":"success","session_id":"...","permission_denials":[...]}`

### Stream-JSON input format
The `--input-format stream-json` expects NDJSON on stdin with this schema:
```json
{"type":"user","message":{"role":"user","content":"prompt text"},"session_id":"default","parent_tool_use_id":null}
```
**NOT** `{"type":"user_message","content":"..."}` — the `type` is `"user"` and `content` is nested inside a `message` object with a `role` field.

### --verbose is required for stream-json
`claude -p --output-format stream-json` requires `--verbose` flag or it errors with: "When using --print, --output-format=stream-json requires --verbose"

### AskUserQuestion is denied in --dangerously-skip-permissions
With `--dangerously-skip-permissions`, `AskUserQuestion` tool calls are auto-denied. The session exits with a `result` event containing `permission_denials` array. The question data is available in `permission_denials[].tool_input`. To continue: save the `session_id` from the result event, then spawn a new `claude -p --resume <sessionId>` with the user's answer.

### Vite watches worktree files
Vite's file watcher sees changes in `.worktrees/` (since `renderer.root: '.'`). When Claude edits files in a worktree, Vite triggers a page reload, destroying all renderer state. Fix: `electron.vite.config.js` ignores `.worktrees/**` in the server watch config.

### Electron main process doesn't inherit shell env vars
macOS Electron apps launched via GUI (not from terminal) don't get `$SHELL`, `$USER`, or a full `$PATH`. `claudeManager.js` resolves the `claude` binary via `findClaudeBinary()` which checks `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, then falls back to `which claude`. Claude is spawned through `/bin/sh -c` (not login shell, to avoid profile sourcing that may re-set Claude env vars).

### electron-vite hot reload only covers renderer
When modifying `electron/` main process files, the dev server does NOT always restart the main process. You must **stop and restart `npm run dev`** to pick up main process changes. Renderer changes (src/) hot-reload normally.

### Task creation is decoupled from session spawn
In `ipc.js`, `tasks:create` wraps `claudeManager.startSession()` in a try/catch so spawn failures don't prevent the task from being created. The task appears on the kanban regardless.

### Process cleanup on app quit
`main.js` calls `claudeManager.stopAll()` on the `before-quit` event to kill all spawned `claude -p` processes. Without this, processes become orphans.

### NDJSON parsing
Claude's stream-json output is newline-delimited JSON. The claudeManager buffers stdout and splits on newlines, parsing each complete line as JSON. Incomplete lines are kept in the buffer until the next chunk arrives.
