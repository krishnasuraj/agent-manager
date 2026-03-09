# Agent Manager

## Vision

A desktop app for managing multiple coding agents (Claude Code, OpenAI Codex CLI, and future tools) working in parallel across workspaces and git worktrees. The key insight: **don't fight the terminal, and don't reinvent state detection**. Coding agents already write structured JSONL session logs to disk. We watch those for state instead of parsing terminal output or running headless agents.

The architecture is: **real terminal (xterm.js + node-pty) for UX** + **JSONL session file watcher for state** + **a sidebar that surfaces what needs your attention**. A **tool config abstraction** (`electron/toolConfigs.js`) makes the system agent-agnostic — each tool provides its own binary path, JSONL schema, session file locations, and PTY detection patterns.

**No headless sessions.** Every agent is a real interactive terminal. The user types `claude` or `codex` themselves, or we inject a command via PTY write. The agent's full interactive UI — spinners, permission prompts, colors — is always present.

---

## Core Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Electron Main Process                                  │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ PTY Manager │  │ JSONL Watcher│  │ Worktree Mgr  │  │
│  │ (node-pty)  │  │ (chokidar)   │  │ (git worktree)│  │
│  └──────┬──────┘  └──────┬───────┘  └───────────────┘  │
│         │                │                              │
│         │  IPC Bridge    │  IPC Bridge                  │
├─────────┼────────────────┼──────────────────────────────┤
│  Electron Renderer Process (React)                      │
│                                                         │
│  ┌────────────────┐  ┌──────────────────────────────┐   │
│  │ Sidebar        │  │ Terminal Panel               │   │
│  │ (session list) │  │ (xterm.js per session)       │   │
│  └────────────────┘  └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Shell | Electron (electron-vite 5, Vite 7) | `electron.vite.config.js` (dot-separated) |
| Frontend | React 19 + Tailwind CSS v4 | `@theme` in CSS, no config file |
| Terminal | xterm.js + @xterm/addon-fit + @xterm/addon-serialize + @xterm/addon-web-links | Renderer process |
| PTY | node-pty | Main process, needs `electron-rebuild` |
| File watching | chokidar | For JSONL session files |
| IPC | contextBridge + ipcRenderer/ipcMain | Standard Electron pattern |
| State | In-memory in main process | No database |
| Fonts | Inter (UI) + JetBrains Mono (terminal) | Google Fonts in index.html |

No component library — custom components only.

---

## State Detection: JSONL Session Files

Each tool writes JSONL session logs to a different location with a different schema. The `toolConfig` abstraction normalizes these into a common event model.

### File Locations

**Claude Code:**
```
~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
```
Files are directly in the project dir — **NOT in a `sessions/` subdirectory**. The encoded path replaces `/`, `_`, and `.` with `-`. Regex: `/[/_.]/g`.
```
/Users/me/my_project → -Users-me-my-project
```

**Codex CLI:**
```
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```
Date-based hierarchy, no cwd encoding in path. Routing requires reading the rollout file or timestamp-based matching (see Stage 6 plan).

### State Derivation

State is derived from the **last meaningful JSONL event** (skipping noise: `file-history-snapshot`, `progress`, `queue-operation`) + time since last write:

| Signal | Derived State |
|--------|---------------|
| Last event has `tool_use`, file still changing | **Working** |
| Last event has `tool_use`, file quiet 5s+ | **Needs Input** (permission prompt) |
| Last event is assistant text, file quiet 5s+ | **Idle** |
| Last event is `tool_result` or user prompt | **Working** |
| `result` event in JSONL | **Done** |
| Shell prompt returns in PTY | **Done** (Ctrl+C fallback) |

Only `user`, `assistant`, `system`, `result` are meaningful types. Walk backward from the end to find the last meaningful event.

### Hybrid PTY + JSONL Detection

JSONL alone can't detect everything. The PTY Manager also scans terminal output. Patterns are **tool-specific** and come from `toolConfig.startupPatterns`, `toolConfig.permissionPatterns`, `toolConfig.thinkingPatterns`.

**Claude Code patterns:**
- **Thinking spinners:** `/\*\s+[A-Z][a-z]+[.…]/` — matches all Claude thinking formats (`* Orbiting…`). Overrides idle to "Working."
- **Permission prompts:** `Allow\s+Deny`, `❯\s*(Allow|Yes)`, etc. Sets "Needs Input" immediately without waiting for stale timer.
- **Startup:** `/╭|Claude Code/`

**Codex CLI patterns:** TBD — requires investigation (Stage 6, step 6). Codex uses Ratatui full-screen alternate screen mode, so ANSI-stripped output may look different from inline terminal tools.

**Shared patterns:**
- **Shell prompt return:** `/(?:^|\n)\s*(?:.*[$%❯>#])\s*$/` — detects agent exiting to shell. Triggers session end (handles Ctrl+C which doesn't write a `result` event).

Rolling 4KB output buffer, ANSI-stripped before matching. Debounce: 3s thinking, 2s permissions, 3s shell return.

### Session File Tracking

Snapshot-based with `Map<filePath, fileSize>`:

1. Before shell spawn, snapshot all `.jsonl` files across all project dirs with sizes
2. **Never lock on `add` events** — Claude creates throwaway files on startup that aren't the real session file
3. **Lock on `change` events** — when a file grows past its snapshot size, that's the real session (new or resumed)
4. Session ends: `result` event OR shell prompt return → unlock, re-snapshot
5. Only two signals end a session: `result` event or shell prompt return. Do NOT use a timeout/stale timer to end sessions — the user might just be reading a long response.

### JSONL Event Schema

```typescript
interface SessionEvent {
  type: 'user' | 'assistant' | 'system' | 'result';
  message: {
    role: 'user' | 'assistant' | 'system';
    content: ContentBlock[] | string;
    usage?: { input_tokens: number; output_tokens: number; ... };
  };
  uuid: string;
  parentUuid?: string;
  sessionId: string;
  timestamp: string;  // ISO-8601
  gitBranch?: string;
  cwd?: string;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
  | { type: 'tool_result'; tool_use_id: string; content: any }
  | { type: 'thinking'; thinking: string }
```

Tool names: `Read`, `Write`, `Bash`, `Task`, `WebSearch`.

### Codex CLI JSONL Event Schema

```typescript
interface CodexRolloutEvent {
  submission_id: number;
  event_msg: CodexEventMsg;
  timestamp: string;  // ISO-8601
}

type CodexEventMsg =
  | { type: 'TurnStarted' }
  | { type: 'AgentMessageDelta'; delta: string }
  | { type: 'ExecCommandBegin'; command: string; cwd: string }
  | { type: 'ExecCommandEnd'; exit_code: number; stdout: string; stderr: string }
  | { type: 'ApprovalRequest'; command: string }
  | { type: 'TurnComplete' }
  // ... more event types TBD (see Stage 6 step 6 investigation)
```

**Note:** This schema is preliminary based on documentation. Must be verified by running Codex and inspecting actual rollout files (Stage 6, step 6).

---

## IPC Protocol

**Main → Renderer:**
| Channel | Payload |
|---------|---------|
| `pty:data` | `(sessionId, data)` — raw PTY output |
| `pty:exit` | `(sessionId, { exitCode, signal })` |
| `jsonl:state` | `(sessionId, { state, summary })` — derived state |
| `jsonl:event` | `(sessionId, { timestamp, icon, label, detail })` — log entry |
| `jsonl:session-started` | `(sessionId)` — Claude session detected |
| `jsonl:session-ended` | `(sessionId)` — Claude session ended |
| `workspaces:changed` | `([{ path, name, isGit }])` — workspace list updated |
| `menu:new-agent` | `()` — File > New Agent clicked |

**Renderer → Main (fire-and-forget):**
| Channel | Payload |
|---------|---------|
| `pty:write` | `(sessionId, data)` — keyboard input |
| `pty:resize` | `(sessionId, cols, rows)` |

**Renderer → Main (invoke):**
| Channel | Payload |
|---------|---------|
| `session:spawn` | `(sessionId, { cwd?, initialPrompt?, toolId? })` — `toolId` defaults to `'claude'` |
| `session:kill` | `(sessionId)` |
| `session:getCwd` | `(sessionId)` |
| `worktree:create` | `(workspace, branch)` → `{ branch, worktreePath, existing }` |
| `worktree:isDirty` | `(workspace, branch)` → `{ dirty }` |
| `worktree:remove` | `(workspace, branch, force?)` |
| `workspace:list` | `()` → `[{ path, name, isGit }]` |
| `workspace:add-via-dialog` | `()` → `{ path, name, isGit }` or `null` |
| `dialog:pick-folder` | `()` → `string` or `null` |
| `app:getTestConfig` | `()` → `{ testSessions, testCwds, testBranches }` |
| `app:getCwd` | `()` → `string` |

---

## File Structure

```
electron/
  main.js               — Electron entry, window creation, IPC wiring, env scrubbing, workspace management, native menu
  preload.js            — contextBridge exposing electronAPI
  ptyManager.js         — PTY lifecycle + output scanning (thinking, permissions, shell return)
  jsonlWatcher.js       — Global JSONL watching, state derivation, session lifecycle
  worktreeManager.js    — Git worktree operations as plain functions (repoRoot per call)
  toolConfigs.js        — (Stage 6) Tool config registry: binary paths, JSONL schemas, PTY patterns per tool
src/
  components/
    TerminalPanel.jsx   — xterm.js terminal with FitAddon + WebLinksAddon
    StateLog.jsx        — Sidebar: state badge + scrolling event log (expandable rows)
    SessionList.jsx     — Sidebar: session list with state dots + close button
    KanbanBoard.jsx     — Board view: 3-column kanban (Idle/Working/Needs Input)
    ResizableSplit.jsx  — Draggable split layout
  App.jsx               — Multi-session orchestration, workspace management, new agent modal, close modal
  main.jsx
  index.css             — Tailwind imports + theme tokens + xterm styles
```

---

## Build & Run

```bash
npm install
npm run rebuild       # electron-rebuild for node-pty
npm run dev           # electron-vite dev — hot reload for renderer only
npm run build         # production build to out/
npm run dist          # build + package macOS DMGs (arm64 + x64)
npm run dist:all      # build + package for all platforms
```

**node-pty rebuild on macOS** — if CLT headers not found:
```bash
CXXFLAGS="-I$(xcrun --show-sdk-path)/usr/include/c++/v1 -isysroot $(xcrun --show-sdk-path)" npx electron-rebuild -f -w node-pty
```

**Main process changes** (`electron/`) require restarting `npm run dev`. Renderer changes (`src/`) hot-reload.

### Releasing a New Version

**1. Bump version** in `package.json`.

**2. Build the DMGs:**
```bash
npm run dist
```

**3. Commit, tag, and push:**
```bash
git add -A && git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push && git push origin vX.Y.Z
```

**4. Create the GitHub Release:**
```bash
gh release create vX.Y.Z \
  "release/Agent Manager-X.Y.Z-arm64.dmg" \
  "release/Agent Manager-X.Y.Z.dmg" \
  release/latest-mac.yml \
  --title "vX.Y.Z" \
  --notes "Release notes here"
```

**5. Update the Homebrew tap** (`krishnasuraj/homebrew-tap`):
```bash
# Get new SHA256 hashes
shasum -a 256 "release/Agent Manager-X.Y.Z-arm64.dmg"
shasum -a 256 "release/Agent Manager-X.Y.Z.dmg"

# Edit Casks/agent-manager.rb in the homebrew-tap repo:
#   - Update `version "X.Y.Z"`
#   - Update both `sha256` values
# Then commit and push to krishnasuraj/homebrew-tap
```

**Install methods for users:**
- **Direct download:** grab the DMG from the GitHub Releases page
- **Homebrew:** `brew install --cask krishnasuraj/tap/agent-manager`
- Both require `xattr -cr "/Applications/Agent Manager.app"` on first launch (not notarized)

### Theme Tokens (`src/index.css` via `@theme`)

Surfaces: `surface-0` (darkest) through `surface-3`. Borders: `border`, `border-bright`. Text: `text-primary`, `text-secondary`, `text-muted`. Status: `status-idle` (gray), `status-running` (blue), `status-guidance` (amber), `status-merged` (green).

---

## Design Direction

Dark mode only. Developer tool aesthetic — Linear meets a terminal. Precise, not playful.

- Dark background (`surface-0`: #0a0a0f), muted surfaces, sharp accent colors for status
- Monospace font for branch names, code references, timestamps, terminal content
- Sans-serif for titles and labels

---

## Staged Build Plan

### Stage 1: Single Terminal + JSONL PoC ✅ Complete

Single window: sidebar (30%) + terminal (70%). Auto-spawns a login shell. User starts Claude themselves. JSONL watcher watches `~/.claude/projects/` globally, picks up any session regardless of directory. Sidebar shows state badge + event log, clears when Claude exits, re-activates on new or resumed session.

**What we validated:**
- chokidar reliably fires on macOS (FSEvents), sub-100ms latency
- State transitions appear within 1-2 seconds
- Working / idle / needs-input are distinguishable
- Terminal works perfectly — full interactive Claude UI
- Session lifecycle (start → exit → resume) works end-to-end

---

### Stage 2: Multi-Session Support ✅ Complete

**Goal:** Run multiple Claude Code sessions simultaneously, each in its own PTY + JSONL watcher. Switch between them in the UI.

**What we built:**
- Session list in sidebar — branch name, state dot, last event summary, click to switch
- Multiple PTYs via ptyManager's existing `sessions` Map
- Single global chokidar watcher routes JSONL events to the correct session (replaced per-session watchers to avoid race conditions)
- CSS-hidden terminal switching (each xterm stays mounted, toggled via `display: none`) — simpler than SerializeAddon and avoids serialize/restore bugs
- Terminal refit on tab switch (`FitAddon.fit()` in `requestAnimationFrame` after becoming visible)
- Test mode via `--test-sessions=N` CLI arg for spawning multiple sessions at once

**Decision: CSS-hidden vs SerializeAddon.** SerializeAddon would save memory (unmounted terminals don't hold DOM nodes) but adds complexity: serialize on switch-away, create new Terminal + restore on switch-back, risk of losing state on serialization edge cases. CSS-hidden is simpler, tested up to 5 simultaneous sessions with no perf issues. Revisit if memory becomes a concern at 10+ sessions.

---

### Stage 3: Worktree Integration + Session Spawning ✅ Complete

**Goal:** Proper git worktree lifecycle. Spawn a new agent on a branch with one click.

**What we built:**
- **"New Agent" modal** (Cmd+N): enter branch name → `git worktree add .worktrees/<branch> -b <branch>` → spawn PTY in worktree dir → auto-type `claude` to launch
- **worktreeManager.js**: `create(branch)` reuses existing worktrees, `remove(branch, {force})`, `isDirty(branch)`, `list()`. Uses `execFileSync` (not `execSync`) to prevent command injection via branch names.
- **Close session modal** with three options: end session (keep worktree), end session + remove worktree (with dirty warning), cancel
- **Branch validation**: `/^[\w][\w./-]*$/` before creating worktree
- **JSONL uses worktree path** (confirmed by testing): `.worktrees/feat-auth/` → `~/.claude/projects/...-worktrees-feat-auth/`

---

### Stage 4: Orchestration Layer ✅ Complete

**Goal:** The app actively helps manage agents, not just display them.

**What we built:**

- **Kanban board view.** Three columns: Idle, Working, Needs Input. Cards show branch name + last event. Click to expand with status detail + "Work with agent" button that switches to Agent view. Board is the default view.
- **View toggle.** Board/Agent toggle in title bar. Both views stay mounted (terminals don't lose state). Creating a new agent auto-switches to Agent view.
- **Multi-workspace support.** Workspaces (git repos or plain directories) are managed in the main process. Workspace selector in New Agent modal with "+ Add workspace" option. Non-git directories supported with a warning (no worktree isolation). Welcome screen when no workspaces configured.
- **Native Electron menu.** File > New Agent (Cmd+N), File > Add Workspace (Cmd+Shift+O). Standard Edit/View/Window menus for copy/paste/devtools.
- **worktreeManager refactored** from factory pattern to plain exported functions. Each function takes `repoRoot` as first arg, enabling multi-workspace worktree operations.
- **Session model** now carries `workspace` field for worktree operations on close.
- **Desktop notifications.** (deferred)
- **Cross-session file conflict detection.** (deferred)
- **CI integration (stretch).** (deferred)

---

### Stage 4.5: Distribution & Release ✅ Complete

**Goal:** Package the app for distribution and set up auto-updates.

**What we built:**
- **electron-builder config** in `package.json`: macOS DMG (arm64 + x64), Windows NSIS, Linux AppImage
- **Auto-updater** via `electron-updater`: checks GitHub Releases on launch, downloads in background, prompts "Restart Now / Later". Skipped in dev mode.
- **App icon**: pixel-art helm converted via `sips` + `iconutil` to `.icns` (macOS) and `.png` (Windows/Linux)
- **GitHub Release workflow**: `npm run dist` builds DMGs, `gh release create` uploads them with release notes
- **Ad-hoc code signing**: no Apple Developer account, so Gatekeeper warns on first launch. Users right-click → Open or use System Settings → Privacy & Security → Open Anyway.

**Scripts:**
- `npm run dist` — build + package macOS DMGs (arm64 + x64)
- `npm run dist:all` — build + package for all platforms

---

### Stage 5: Polish + Advanced Features

- **Search.** Full-text search across JSONL transcripts.
- **Cost tracking.** JSONL includes token usage per turn — sum and display per-session cost.
- **Session replay.** Load a completed JSONL and replay the event timeline.
- **Claude Code hooks.** Register PreToolUse/PostToolUse/Stop hooks that write to a named pipe. Gives sub-second tool-level events before JSONL is written.
- **MCP `requestGuidance` server.** Small MCP server exposing a `requestGuidance(question)` tool. When Claude calls it, show the question in the UI with a text input. User's answer is returned as the tool result. Cleanly solves the guidance/input problem.

---

### Stage 6: Multi-Tool Support (Codex CLI)

**Goal:** Support OpenAI Codex CLI alongside Claude Code. Any coding agent that runs in a terminal and writes JSONL session logs can be managed.

#### Background: Codex CLI

OpenAI's open-source coding agent ([github.com/openai/codex](https://github.com/openai/codex)). Rust binary, installed via `npm install -g @openai/codex` or `brew install codex`. Two modes: interactive TUI (Ratatui full-screen) and headless (`codex exec`). Uses `AGENTS.md` (analogous to `CLAUDE.md`). Three-tier permission model (untrusted/on-request/never) with platform-specific sandboxing.

#### Codex vs Claude Code: Key Differences

| Aspect | Claude Code | Codex CLI |
|--------|-------------|-----------|
| Session files | `~/.claude/projects/<encoded-path>/<uuid>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Path scheme | Encoded cwd (`/[/_.]/g` → `-`) | Date-based directory hierarchy |
| JSONL schema | `{type, message, uuid, sessionId}` | `{submission_id, event_msg, timestamp}` |
| Event types | `user`, `assistant`, `system`, `result` | `TurnStarted`, `AgentMessageDelta`, `ExecCommandBegin`, `ApprovalRequest`, `TurnComplete` |
| TUI | Inline terminal (works naturally in xterm.js) | Ratatui full-screen alternate screen |
| Resume | `claude --resume <id>` (appends to same JSONL) | `codex resume [SESSION_ID]` (replays rollout) |
| Config | `~/.claude/` | `~/.codex/config.toml` |
| Nesting env vars | `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT` | Not documented |

#### Step 1: Tool Config Abstraction

Create `electron/toolConfigs.js` — a registry of tool-specific constants, patterns, and parsers. Each tool config provides:

```javascript
{
  id: 'claude' | 'codex',
  displayName: 'Claude Code' | 'Codex CLI',
  binary: 'claude' | 'codex',
  binarySearchPaths: [...],           // candidates for findBinary()
  sessionRoot: '~/.claude/projects'|'~/.codex/sessions',
  resumeCmd: (id) => string,          // e.g. 'claude --resume "id"' or 'codex resume id'
  envPrefixToScrub: 'CLAUDE' | null,  // env vars to delete to prevent nesting
  // PTY detection patterns
  startupPatterns: RegExp[],           // detect tool launched in terminal
  permissionPatterns: RegExp[],        // detect permission/approval prompts
  thinkingPatterns: RegExp[],          // detect thinking/processing indicators
  // JSONL parsing
  watchPath: string,                   // chokidar root (different structure per tool)
  watchDepth: number,                  // chokidar depth
  parseEvent: (line) => NormalizedEvent,  // parse tool-specific JSONL → common schema
  deriveState: (events, staleness) => State,
  isNoiseEvent: (event) => boolean,
  // Session file routing
  matchFileToSession: (filePath, sessions) => sessionId | null,
}
```

**Normalized event schema** (tool-agnostic, used by sidebar/kanban):
```typescript
interface NormalizedEvent {
  type: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'thinking' | 'result';
  toolName?: string;
  summary?: string;
  timestamp: string;
  raw: any;  // original event for debugging
}
```

#### Step 2: Refactor ptyManager.js

- Replace `findClaudeBinary()` with `findBinary(toolConfig)`
- Replace hardcoded `PERMISSION_PATTERNS`, `SHELL_PROMPT_PATTERNS`, startup detection with `toolConfig.permissionPatterns`, etc.
- Parameterize auto-launch: `toolConfig.binary` instead of hardcoded `'claude'`
- Session model gains `toolId` field: `{ id, cwd, workspace, toolId: 'claude'|'codex' }`

#### Step 3: Refactor jsonlWatcher.js

This is the biggest change. Currently watches `~/.claude/projects/` with Claude-specific path encoding and event parsing.

- **Watch multiple roots.** One chokidar watcher per active tool (Claude: `~/.claude/projects/`, Codex: `~/.codex/sessions/`). Or a single watcher if both roots can be watched.
- **Routing.** Claude routes by encoded cwd in path. Codex uses date-based dirs — routing requires reading the rollout file to find cwd, or matching by `submission_id`.
- **Event parsing.** `toolConfig.parseEvent(line)` normalizes to common schema. State derivation uses `toolConfig.deriveState()`.
- **Session lifecycle.** Claude: lock on `change` when file grows past snapshot. Codex: TBD — need to test whether Codex also creates throwaway files or writes cleanly.

**Key risk:** Codex's date-based session directory (`YYYY/MM/DD/rollout-*.jsonl`) doesn't encode the cwd in the path. Routing JSONL files to sessions can't use the same cwd-matching approach. Options:
1. Read the first event in the rollout file to get the cwd/session context
2. Track which rollout file was created after spawning (timestamp-based matching)
3. Use Codex's `submission_id` to correlate

#### Step 4: Refactor main.js

- Scrub env vars per tool config (`envPrefixToScrub`)
- `session:spawn` IPC gains `toolId` parameter
- New Agent modal passes selected tool to spawn

#### Step 5: UI Changes

- **New Agent modal:** Add tool selector (Claude Code / Codex CLI) before branch name. Remember last selection.
- **Session list:** Show tool icon/label per session so user knows which agent is which.
- **Kanban cards:** Tool indicator (small icon or label).
- **State colors:** Same status colors regardless of tool (Working = blue, Needs Input = amber, Idle = gray).

#### Step 6: Codex-Specific Investigation (do first)

Before writing code, manually test Codex in the app's xterm.js terminal:

1. Spawn a shell, run `codex` manually. Does the Ratatui full-screen UI work in xterm.js? (It should — xterm.js is a real VT emulator.)
2. Run a Codex session, inspect `~/.codex/sessions/` — document the exact JSONL event flow, field names, event ordering.
3. Test PTY output scanning — what does ANSI-stripped Ratatui output look like? Can we detect startup, permissions, exit?
4. Test `codex resume` — does it append to the same rollout file or create a new one?
5. Check if Codex sets any env vars that would cause nesting issues.

**This investigation must happen before steps 1–5.** The Codex JSONL schema and PTY output patterns will determine the exact implementation.

#### What Stays the Same

- xterm.js terminal rendering (tool-agnostic)
- Worktree management (pure git, no tool dependency)
- IPC protocol structure (session lifecycle channels)
- Kanban board layout and interaction
- CSS-hidden terminal switching

---

## Critical Gotchas

### Claude nesting detection
The `claude` binary hangs silently when spawned inside another Claude session. Env vars: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`. Fix: `main.js` scrubs all `CLAUDE*` env vars at startup. `ptyManager.js` uses `getCleanEnv()`.

### JSONL path encoding
Both `/`, `_`, AND `.` replaced with `-`. Regex: `/[/_.]/g`. Getting this wrong = watching the wrong directory and never finding sessions.

### JSONL files not in sessions/ subdirectory
Despite what you might expect, files are directly in `~/.claude/projects/<encoded-path>/`, not `sessions/`.

### Never lock on chokidar `add` events
Claude creates throwaway `.jsonl` files on startup that aren't the real session. Lock only on `change` events when the file grows past its snapshot size.

### Ctrl+C exit doesn't write a result event
Must detect shell prompt return via PTY output scanning. `notifyShellReturn()` in jsonlWatcher handles this.

### Resumed sessions write to existing files
`claude --resume <id>` writes to the existing JSONL file. Snapshot stores sizes so `change` events on existing files can be detected as resumes (read from byte 0 to load full history).

### Never use a stale timer to end sessions
A long response or extended thinking means no JSONL writes for a long time. Don't interpret silence as "Claude exited." Only shell prompt return or `result` event ends a session.

### JSONL routing requires unique cwds per session
`routeFileChange` matches JSONL files to sessions by comparing encoded cwds. If two sessions share a cwd, their JSONL files can be routed to the wrong session. Worktrees guarantee unique cwds. Never add a fallback that assigns files to "any unlocked session" — this was the root cause of the crossed-wires bug.

### Vite watches worktree files
Ignore `.worktrees/**` in `electron.vite.config.js` `server.watch.ignored`.

### Electron main process doesn't inherit shell env
`findClaudeBinary()` checks `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, then `which claude`.

### node-pty rebuild on macOS
If `fatal error: 'functional' file not found`:
```bash
CXXFLAGS="-I$(xcrun --show-sdk-path)/usr/include/c++/v1 -isysroot $(xcrun --show-sdk-path)" npx electron-rebuild -f -w node-pty
```

### node-pty `posix_spawnp failed` after dependency changes
If node-pty throws `posix_spawnp failed` at runtime, the native binary is out of sync with Electron. Fix: `npm run rebuild`. This commonly happens after installing/updating packages or switching Electron versions.

### electron-updater is CommonJS
`electron-updater` doesn't support ESM named exports. Must use default import:
```js
import pkg from 'electron-updater'
const { autoUpdater } = pkg
```
NOT `import { autoUpdater } from 'electron-updater'` — this throws `SyntaxError: Named export 'autoUpdater' not found`.

### Universal macOS build fails with node-pty
`@electron/universal` can't merge arm64 and x64 node-pty binaries ("Detected file that's the same in both x64 and arm64 builds"). Fix: build separate arm64 and x64 DMGs instead of a universal binary.

### macOS Gatekeeper without Apple Developer account
Ad-hoc signed apps trigger "Apple could not verify" warning. Users must: right-click → Open, or System Settings → Privacy & Security → Open Anyway. Apple Developer Program ($99/year) is the only way to get notarization and remove the warning.

---

## Deleted Files (v5 leftovers, removed after Stage 3)

These files were part of the v5 "headless Claude via stdin/stdout" architecture, replaced entirely by the v6 terminal + JSONL approach. None were imported by any active code.

| File | Prior function |
|------|---------------|
| `electron/claudeManager.js` | Headless Claude process manager — spawned `claude` via `child_process`, communicated via stdin/stdout JSON |
| `electron/ipc.js` | v5 IPC handler registration for task CRUD (create/delete/send-message/abort) |
| `electron/seed.js` | Auto-created test tasks on `--seed` flag for v5 board UI |
| `electron/taskStore.js` | In-memory task store with status tracking, message history, worktree paths |
| `electron/worktree.js` | Old worktree helper using `execSync` (replaced by `worktreeManager.js` with `execFileSync`) |
| `src/components/BoardView.jsx` | Kanban board view grouping tasks by status columns |
| `src/components/QueueView.jsx` | Flat task queue list view |
| `src/components/SessionPanel.jsx` | Chat-style session panel showing Claude messages + tool calls |
| `src/components/TaskCard.jsx` | Task card component for board/queue views |
| `src/components/TaskModal.jsx` | Modal for creating new tasks with title + prompt |
| `src/components/ToolCallCard.jsx` | Expandable card showing tool name, input, result |
| `src/components/TopBar.jsx` | v5 top navigation bar with view switcher |
| `src/hooks/useSession.js` | React hook for v5 session state (messages, streaming, questions) |
| `src/hooks/useTasks.js` | React hook for v5 task list via IPC |
| `src/hooks/useTypewriter.js` | Typewriter text animation effect |
| `project_spec.md` | Original project spec, superseded by this file (CLAUDE.md) |
| `TEST_PROMPTS.md` | v5 test prompts documentation |
| `test-prompt.md` | Single test prompt for manual testing |

---

## Stage 1 Implementation Log

### What We Built

Single window: login shell spawned automatically, user types `claude`. JSONL watcher watches `~/.claude/projects/` globally (not tied to a specific project dir). Sidebar shows state badge + event log, wipes on exit, re-activates on new or resumed session.

### Key Implementation Decisions

1. **Watch globally, not per-project.** Initial impl watched the app's own project dir. When user `cd`'d to a different project, sessions were missed. Fix: watch all of `~/.claude/projects/` with `depth: 1`.

2. **Lock on `change`, not `add`.** First impl locked on `add` (new file detected). Claude creates a throwaway file on startup before writing the real session file — we'd lock onto the wrong file and miss all events. Fix: record new files on `add` with size 0, lock only when a file starts actively growing via `change`.

3. **Snapshot as `Map<path, size>`, not `Set<path>`.** Needed to detect resumed sessions (existing file growing) vs new sessions. Size comparison is the signal.

4. **Shell prompt return detection for Ctrl+C.** `result` event isn't written on Ctrl+C. Added PTY output scanning: when shell prompt appears after Claude was running, immediately end the session.

5. **Clear buffer on Claude start.** When re-detecting Claude after exit, clear the output buffer so stale shell prompts don't immediately trigger a false shell-return detection.

6. **Meaningful event types only.** Events like `file-history-snapshot`, `progress`, `queue-operation` are noise. `deriveState()` walks backward to find the last `user`/`assistant`/`system`/`result` event.

7. **Thinking spinner detection.** Single regex `/\*\s+[A-Z][a-z]+[.…]/` matches all Claude thinking formats. Enumerating individual words doesn't work (too many, new ones added). Tracking all PTY activity doesn't work (cursor blink = false positive).

8. **Separate `ptySessionId` from `claudeActive`.** Terminal (`ptySessionId`) persists across session boundaries. Sidebar tracking (`claudeActive`) only active when JSONL watcher has locked onto a session.

### Bugs Encountered

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Status always "Idle" | Noise events (`file-history-snapshot` etc.) were the "last event" | Walk backward to find last meaningful event |
| Watcher watching wrong dir | Watched app's own project dir, not the user's current project | Watch all of `~/.claude/projects/` globally |
| Locked onto wrong file on resume | `add` event fired for throwaway file before real session file | Lock only on `change` |
| Sidebar not clearing on Ctrl+C | No `result` event written | Shell prompt return detection in ptyManager |
| Sidebar clearing while reading | Stale timer (30s) ending sessions | Remove timeout-based session end entirely |
| Resume not loading history | Watcher only looked for new files | Detect existing file growing past snapshot size |
| False shell-return on resume | Stale shell prompt in buffer triggered detection immediately after resume | Clear buffer when Claude start detected |
| Terminal blank after spawn screen removed | `setPtySessionId()` call removed accidentally | Separate `ptySessionId` (always set) from `claudeActive` |

---

## Stage 2 Implementation Log

### Key Decisions

1. **Single global chokidar watcher, not per-session.** Multiple independent watchers on the same `~/.claude/projects/` directory caused race conditions — non-deterministic callback ordering meant the wrong session would claim a JSONL file. Fix: one global watcher, one `routeFileChange()` function that routes each event to the correct session.

2. **CSS-hidden terminals, not SerializeAddon.** Each xterm.js instance stays mounted in the DOM with `display: none` when inactive. Simpler and avoids edge cases with serialize/restore. Requires `FitAddon.fit()` on `requestAnimationFrame` when switching back (the terminal needs a paint cycle after `display` changes).

3. **IPC handlers outside `createWindow()`.** On macOS, `app.on('activate')` can call `createWindow()` again. If IPC handlers are registered inside it, they double-register and break. Move all `ipcMain.handle` calls to module scope.

### Bugs Encountered

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Crossed session statuses | Per-session chokidar watchers raced; random session claimed each file | Single global watcher with `routeFileChange()` |
| False shell return ending sessions | Broad shell prompt regex matched Claude's output (e.g. `$` in code) | 5 specific patterns + double-match requirement (500ms apart) |
| Session statuses "shift up" to wrong session | `routeFileChange` second-pass fallback assigned any file to any unlocked session | Remove fallback — only cwd-matched sessions can claim files |
| No statuses after removing fallback | `encodeProjectPath` didn't replace `.` — `.worktrees` encoded as `-.worktrees` but Claude uses `--worktrees` | Regex `/[/_]/g` → `/[/_.]/g` |
| Thinking blocks showed as idle | `deriveState()` checked `tool_use` and `text` blocks but not `thinking` blocks | Add `thinking` check before text block check |

---

## Stage 3 Implementation Log

### Key Decisions

1. **Worktrees solve cross-session routing.** Each session gets a unique cwd via git worktree, so `routeFileChange` can match by cwd alone. No ambiguous fallback needed.

2. **Auto-type `claude`, not the full binary path.** The PTY inherits the user's PATH, so just typing `claude` works. Typing `/Users/.../.local/bin/claude` looks wrong in the terminal and breaks if the binary is elsewhere.

3. **`execFileSync` not `execSync` for git operations.** Branch names come from user input. `execSync` with string interpolation = command injection. `execFileSync` takes an argv array, preventing injection entirely.

4. **Close modal, not `confirm()`.** Closing a session has multiple valid outcomes (keep worktree vs remove it). A three-option modal is clearer than nested confirms.

5. **500ms delay between kill and worktree remove.** `git worktree remove` fails if the PTY process still has the directory as its cwd. The delay is a pragmatic workaround; a proper fix would await PTY exit.

### Bugs Encountered

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| `git worktree add` fails on existing branch | No check for existing worktree | `fs.existsSync` check, return `{ existing: true }` |
| Worktree not deleted on close | PTY process holds directory as cwd | 500ms delay between `killSession` and `worktreeRemove` |
| macOS title bar overlaps traffic lights | `hiddenInset` title bar style needs left padding | `pl-16` on title element |

---

## Stage 4 Implementation Log (Orchestration + Multi-Workspace)

### Key Decisions

1. **Workspaces are metadata, not architectural boundaries.** A workspace is just `{ path, name, isGit }`. The single window shows all agents across all workspaces. Worktree operations are parameterized by workspace path. No per-workspace managers or separate windows.

2. **worktreeManager as plain functions, not a factory.** The factory pattern (`createWorktreeManager(repoRoot)`) bound operations to a single repo. With multi-workspace, each call needs a different repo root. Refactored to exported functions: `worktreeCreate(repoRoot, branch)`, `worktreeRemove(repoRoot, branch)`, etc. No cached state — stateless is simpler.

3. **Non-git directories allowed as workspaces.** The initial implementation rejected non-git directories with `dialog.showErrorBox`. This was too restrictive — users may want to run Claude in any directory. Fix: accept any directory, tag with `isGit: boolean`. The New Agent modal adapts: git repos get branch name + worktree creation, non-git dirs get a warning and launch directly.

4. **Native Electron menu for keyboard shortcuts.** Cmd+N was initially handled via a `keydown` listener in the renderer. Moved to native menu accelerator for proper macOS feel. Also added Cmd+Shift+O for Add Workspace. Menu sends IPC events (`menu:new-agent`) to the renderer.

5. **Board view as default.** The kanban board gives the best overview when managing multiple agents. Agent view is for focused interaction. Creating a new agent auto-switches to Agent view so you can see the terminal immediately.

6. **Welcome screen within main layout, not early return.** First implementation used an early `return` for the welcome screen (no workspaces). This caused the New Agent modal to render on top of a bare screen with no title bar. Fix: render welcome content inside the main layout so the title bar is always present.

7. **Terminal preview in kanban cards is fundamentally impossible.** Attempted 6+ approaches: ANSI stripping (garbled — terminal bytes aren't text), raw xterm replay at narrow width (wraps wrong — PTY output designed for specific column count), CSS transform scaling (terminal still renders at container width), SerializeAddon (same column-width problem). Root cause: PTY output contains cursor movements and overwrites designed for a specific terminal width. You cannot display it at a different width without re-rendering through the original-width terminal. Abandoned.

### Bugs Encountered

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| No title bar behind New Agent modal on first launch | Welcome screen used early `return`, modal rendered on bare screen | Render welcome as content within main layout, not a separate return |
| Can't select workspace in New Agent modal | Single-workspace case showed static label, no way to change | Always show dropdown with "+ Add workspace" option |
| "Not a Git Repository" error blocks adding non-git workspaces | `addWorkspaceViaDialog` rejected non-git dirs with `showErrorBox` | Allow any directory, tag with `isGit` flag, show warning in modal |
| `openNewAgentModal()` infinite recursion | `replace_all` on `setShowNewAgent(true)` → `openNewAgentModal()` also replaced the one inside the function body | Manual fix: ensure function body calls `setShowNewAgent(true)` not itself |

---

## Stage 4.5 Implementation Log (Distribution & Release)

### Key Decisions

1. **Separate arch builds, not universal.** `@electron/universal` fails on node-pty native binaries. Building separate arm64 and x64 DMGs is simpler and avoids the merge issue entirely.

2. **CXXFLAGS in dist script.** node-pty rebuild during `electron-builder` needs the same macOS CLT header workaround as manual `electron-rebuild`. Baked into the `dist` npm script so it's not forgotten.

3. **Auto-updater checks GitHub Releases.** `electron-updater` with `publish.provider: "github"` checks for new releases on app launch. Downloads in background, prompts restart. Skipped when `ELECTRON_RENDERER_URL` is set (dev mode).

4. **Ad-hoc signing is fine for now.** Apple notarization requires $99/year Developer Program. For developer-audience distribution, the Gatekeeper workaround (right-click → Open) is acceptable. Revisit if distributing to non-technical users.

### Code Cleanup Applied

Ran `/simplify` review across the codebase. Fixes applied:

**`electron/main.js`:**
- Extracted `getActiveWindow()` helper — replaced 4 inline `mainWindow || BrowserWindow.getAllWindows()[0]` patterns
- Extracted `pickDirectory()` helper — replaced 3 duplicate `dialog.showOpenDialog` calls (workspace add via dialog, folder picker IPC, menu Add Workspace)

**`src/App.jsx`:**
- Extracted `removeSession(sessionId)` — deduplicated identical `setSessions` filter + activeId logic from `doEndSession` and `doEndSessionAndRemoveWorktree`
- Removed duplicate `getWorkspaces()` call on mount — reused promise from first call via `wsPromise`
- Fixed `onMenuNewAgent` listener churn — uses `workspacesRef` (a ref) so the effect registers once (`[]` deps) instead of tearing down/re-registering on every workspace change
- Extracted `addWorkspaceViaDialog()` — shared by `handleAddWorkspace` and the workspace select `onChange` handler

### Bugs Encountered

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| `SyntaxError: Named export 'autoUpdater' not found` | `electron-updater` is CommonJS, can't use ESM named imports | Default import: `import pkg from 'electron-updater'; const { autoUpdater } = pkg` |
| `posix_spawnp failed` on session spawn | node-pty native binary out of sync after dependency changes | `npm run rebuild` to recompile node-pty for current Electron |
| Universal macOS build fails | `@electron/universal` can't merge arm64/x64 node-pty binaries | Build separate arm64 and x64 targets instead |
