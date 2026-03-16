# Agent Navigator

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

**Codex CLI — PTY detection is limited (Ratatui garbles ANSI-stripped output):**
- **Startup only:** `/OpenAI Codex/` or `/codex/i` — detects launch, triggers immediate "Working" state. Has 3s cooldown before shell-return checks resume.
- **Working/thinking:** NOT detected via PTY — Ratatui cursor positioning produces garbled text after ANSI stripping. State comes from JSONL events (`task_started`, `agent_message`).
- **Permission prompts:** NOT detected via PTY — detected via JSONL stale timer (`function_call` with no `function_call_output` for 3s).

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

### Codex CLI JSONL Event Schema (verified v0.114.0)

Top-level event structure: `{ timestamp: string, type: string, payload: object }`

**Top-level types:**

| Type | Payload type | Purpose |
|------|-------------|---------|
| `session_meta` | — | First event. Has `id`, `cwd`, `originator`, `cli_version`, `source`, `model_provider` |
| `response_item` | `message` | System/developer instructions (noise for state) |
| `response_item` | `reasoning` | Encrypted reasoning content |
| `response_item` | `function_call` | Tool call: `{ name, arguments, call_id }` |
| `response_item` | `function_call_output` | Tool result: `{ call_id, output }` |
| `response_item` | `custom_tool_call` | Custom tool (e.g. `apply_patch`) |
| `response_item` | `custom_tool_call_output` | Custom tool result |
| `response_item` | `web_search_call` | Web search invocation |
| `event_msg` | `task_started` | Turn begins. Has `turn_id`, `model_context_window` |
| `event_msg` | `user_message` | User's prompt: `{ message, images }` |
| `event_msg` | `agent_message` | Agent's text response: `{ message }` |
| `event_msg` | `agent_reasoning` | Visible reasoning summary: `{ text }` |
| `event_msg` | `token_count` | Token usage per turn (noise for state) |
| `event_msg` | `task_complete` | **Session/turn end signal**: `{ turn_id, last_agent_message }` |
| `event_msg` | `turn_aborted` | Interrupted: `{ reason }` |
| `turn_context` | — | Per-turn metadata: `cwd`, `model`, `approval_policy`, `sandbox_policy` |

**Key differences from Claude Code JSONL:**
- `task_complete` is the explicit end signal (Claude uses `result` type)
- `session_meta` has `cwd` directly — used for routing (Claude encodes cwd in file path)
- **Approval prompts are NOT logged as JSONL events** — purely TUI-rendered. Detection is via PTY output only.
- New session = new rollout file. Multi-turn within a session appends to the same file.
- `codex resume <id>` appends to the existing rollout file (same as Claude's `--resume`).

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
  "release/Agent Navigator-X.Y.Z-arm64.dmg" \
  "release/Agent Navigator-X.Y.Z.dmg" \
  release/latest-mac.yml \
  --title "vX.Y.Z" \
  --notes "Release notes here"
```

**5. Update the Homebrew tap** (`krishnasuraj/homebrew-tap`):
```bash
# Get new SHA256 hashes
shasum -a 256 "release/Agent Navigator-X.Y.Z-arm64.dmg"
shasum -a 256 "release/Agent Navigator-X.Y.Z.dmg"

# Edit Casks/agent-navigator.rb in the homebrew-tap repo:
#   - Update `version "X.Y.Z"`
#   - Update both `sha256` values
# Then commit and push to krishnasuraj/homebrew-tap
```

**Install methods for users:**
- **Direct download:** grab the DMG from the GitHub Releases page
- **Homebrew:** `brew install --cask krishnasuraj/tap/agent-navigator`
- Both require `xattr -cr "/Applications/Agent Navigator.app"` on first launch (not notarized)

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

### Stages 1–4.5 ✅ Complete

- **Stage 1:** Single terminal + JSONL PoC — sidebar + terminal, global JSONL watching
- **Stage 2:** Multi-session — session list, CSS-hidden terminal switching, single global chokidar watcher
- **Stage 3:** Worktree integration — New Agent modal (Cmd+N), worktreeManager.js, close modal with keep/remove options, branch validation (`/^[\w][\w./-]*$/`)
- **Stage 4:** Orchestration — kanban board (Idle/Working/Needs Input), Board/Agent view toggle, multi-workspace support, native Electron menu (Cmd+N, Cmd+Shift+O)
- **Stage 4.5:** Distribution — electron-builder (separate arm64/x64 DMGs), auto-updater via GitHub Releases, ad-hoc code signing

Deferred: desktop notifications, cross-session file conflict detection.

---

### Stage 4.6: CI Release Pipeline (GitHub Actions)

**Goal:** Automate `npm run dist` + GitHub Release creation so releases don't require 10+ minutes of local waiting for signing/notarization.

- **Trigger:** Push a version tag (`v*`) to kick off the workflow.
- **macOS runner:** `macos-latest` with Xcode codesigning. Store Apple Developer ID certificate, password, Apple ID, app-specific password, and team ID as GitHub Actions secrets.
- **Steps:** Install deps → rebuild node-pty → electron-builder `--mac` → upload DMGs, zips, `latest-mac.yml` as GitHub Release artifacts.
- **Signing in CI:** Import the `.p12` certificate into a temporary keychain on the runner. Export `CSC_LINK` (base64 cert) and `CSC_KEY_PASSWORD` as secrets. electron-builder picks these up automatically.
- **Notarization in CI:** Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` as secrets. The existing `afterSign` hook (`electron/notarize.js`) handles the rest.
- **Homebrew tap update:** Optionally add a step to compute SHA256 hashes and open a PR against `krishnasuraj/homebrew-tap`.

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
| JSONL top-level | `{type, message, uuid, sessionId}` | `{timestamp, type, payload}` |
| Meaningful events | `user`, `assistant`, `system`, `result` | `event_msg:task_started/user_message/agent_message/task_complete`, `response_item:function_call` |
| Session end | `result` event | `event_msg:task_complete` |
| Approval prompts | JSONL stale timer on `tool_use` + PTY patterns | **PTY only** — not logged in JSONL |
| TUI | Inline terminal | Ratatui full-screen alternate screen |
| Resume | `claude --resume <id>` (appends to same JSONL) | `codex resume <id>` (appends to same rollout) |
| Config | `~/.claude/` | `~/.codex/config.toml` |
| Nesting env vars | `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT` | None documented |
| Routing | Encoded cwd in file path | `cwd` in `session_meta` payload (read first line) |

#### What was built

- **`electron/toolConfigs.js`**: Tool config registry. Each config provides `findBinary()`, `startupPatterns`, `permissionPatterns`, `thinkingPatterns`, `deriveState()`, `eventToLogEntry()`, `matchFileToSession()`, `snapshotFiles()`, `resnapshotForSession()`, `isSessionEndEvent()`, `isNoiseEvent()`.
- **`electron/ptyManager.js`**: Parameterized by `toolConfig`. Startup/permission/thinking patterns come from config. Added `onStartup` callback + `startupCooldownMs` for TUI apps. `claudeRunning` → `agentRunning`.
- **`electron/jsonlWatcher.js`**: One chokidar watcher per tool root (not one global). Tool-specific event parsing, state derivation, session end detection. Added `notifyStartup()` for immediate "Working" state before JSONL locks.
- **`electron/main.js`**: Scrubs env vars for all tools. `session:spawn` accepts `toolId`. Exposes `tools:list` IPC.
- **UI**: Tool selector (toggle buttons) in New Agent modal. Tool badge on session list and kanban cards. Tool-agnostic close modal text.

#### Key Decisions

1. **Codex state = event-driven, not timer-driven.** Claude uses stale timers on `tool_use` to detect permission prompts (5s of no JSONL writes). Codex has explicit turn lifecycle events (`task_started`, `task_complete`), so `agent_message` always means "working" until `task_complete`. The only stale timer: `function_call` with no `function_call_output` for 3s → "needs-input" (approval prompt).

2. **PTY pattern matching doesn't work for Ratatui.** ANSI-stripping full-screen Ratatui output produces garbled text (`WWo•Wor2•Work•WorkiWorkin•Working...`) because cursor positioning overwrites the same screen positions. The stripped buffer is useless for regex matching. Solution: Codex `thinkingPatterns` and `permissionPatterns` are empty — all state comes from JSONL events.

3. **`task_complete` is per-turn, not per-session.** Initially treated `task_complete` as a session-end event (like Claude's `result`), which unlocked the session after every turn and broke state tracking. Fix: `isSessionEndEvent()` always returns `false` for Codex. Sessions only end via shell prompt return.

4. **Codex `session_meta` is huge.** The first JSONL line includes the entire system prompt (`base_instructions`) — tens of KB. Initial implementation tried `JSON.parse` on a 4KB buffer, which silently failed. Fix: regex extraction (`/"cwd"\s*:\s*"([^"]+)"/`) from the first 1KB, where `cwd` always appears early in the payload.

5. **Startup cooldown for TUI apps.** After detecting Codex in PTY output, there's a 1-2 second gap before the alternate screen activates. During this gap, shell prompt patterns (`%`) match and trigger false shell-return detection. Fix: 3-second `startupCooldownMs` — ignore all PTY checks during this window.

6. **PTY startup → immediate "Working" state.** The JSONL file isn't created until several seconds after Codex launches. Without this, the sidebar shows "Idle / Waiting..." while Codex is already processing. `notifyStartup()` sends "Working / Starting..." and `jsonl:session-started` immediately on PTY startup detection.

7. **No-op resize to prevent Ratatui redraw.** `FitAddon.fit()` on tab switch sends `pty:resize`, which triggers Ratatui to redraw the entire screen. Fix: only send `pty:resize` when `cols` or `rows` actually changed.

8. **JSONL streaming lag is inherent.** Codex writes `agent_message` and `task_complete` at the end of a response, not during streaming. So the sidebar shows "Working" while the poem is already fully visible in the terminal. This is a fundamental limitation of JSONL-based state detection — real-time streaming state would require PTY parsing, which doesn't work for Ratatui.

#### Bugs Encountered

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| `fileCwd=null` — JSONL routing never matches | `session_meta` first line is ~20KB (includes system prompt), 4KB buffer truncated it, `JSON.parse` failed silently | Regex extraction of `"cwd"` from first 1KB instead of parsing full JSON |
| State stays "Idle" while Codex is working | `agent_message` + `timeSinceWrite > 5s` → idle, and PTY thinking patterns can't match garbled Ratatui output | Remove `timeSinceWrite` for Codex — `agent_message` always = working |
| Session unlocks after every turn | `task_complete` treated as session-end event | `isSessionEndEvent()` returns `false` for Codex |
| False shell return right after Codex starts | Shell `%` prompt visible in buffer before alternate screen activates | 3s `startupCooldownMs` after startup detection |
| "No active session" while Codex is working | JSONL file not yet created when TUI starts | `notifyStartup()` sends immediate state from PTY detection |
| Ratatui redraws on tab switch | `pty:resize` sent even when dimensions unchanged | Only send resize on genuine size changes (non-zero → different non-zero), not hidden→visible transitions |
| Old rollout files claimed on startup | `add` handler registered files with size 0, so old files looked "new" | Register with actual file size via `statSync` |

#### Open Issues

- **Ratatui TUI scroll/redraw on view switch.** Switching between Board and Agent views still causes Codex's Ratatui TUI to snap the input area to the top. Current mitigation: skip `pty:resize` on hidden→visible transitions. Root cause may be `FitAddon.fit()` calling `term.resize()` internally even without sending to PTY, or xterm.js re-rendering the alternate screen buffer on container visibility change. Needs further investigation.

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

## Implementation Notes (Stages 1–4.5)

Key architectural decisions made during implementation (all stages complete):

- **Watch globally, not per-project** — watch all of `~/.claude/projects/` with `depth: 1`
- **Single global chokidar watcher** — per-session watchers caused race conditions; one watcher + `routeFileChange()` routes events to correct session
- **CSS-hidden terminals** — each xterm stays mounted with `display: none` when inactive; simpler than SerializeAddon, no perf issues up to 5 sessions
- **IPC handlers at module scope** — registering inside `createWindow()` causes double-registration on macOS `activate`
- **`execFileSync` for git** — prevents command injection from branch names (vs `execSync` with interpolation)
- **Auto-type tool name, not binary path** — PTY inherits user's PATH; typing full path looks wrong and breaks portability
- **500ms delay between kill and worktree remove** — PTY process holds cwd; delay prevents `git worktree remove` failure
- **Workspaces are metadata** — just `{ path, name, isGit }`, no per-workspace managers; non-git dirs allowed with warning
- **Board view default, Agent view on create** — kanban overview for managing, terminal view for focused interaction
- **Terminal preview in kanban cards is impossible** — PTY output has cursor movements for specific column width; can't re-render at different width
- **Separate arch builds** — `@electron/universal` fails on node-pty; build separate arm64/x64 DMGs
- **Helpers extracted in /simplify pass** — `getActiveWindow()`, `pickDirectory()`, `removeSession()`, `addWorkspaceViaDialog()`
