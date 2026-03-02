# Claude Code Orchestrator — Project Spec

## Vision

A desktop app for managing multiple Claude Code agents working in parallel across git worktrees. The key insight driving this rewrite: **don't fight the terminal, and don't reinvent state detection**. Claude Code already writes structured JSONL session logs to disk. We watch those files for state instead of parsing terminal output or running headless agents.

The architecture is: **real terminal (xterm.js + node-pty) for UX** + **JSONL session file watcher for state** + **a sidebar that surfaces what needs your attention**.

---

## Core Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Electron Main Process                                  │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ PTY Manager │  │ JSONL Watcher│  │ Worktree Mgr  │  │
│  │ (node-pty)  │  │ (fs.watch)   │  │ (git worktree)│  │
│  └──────┬──────┘  └──────┬───────┘  └───────────────┘  │
│         │                │                              │
│         │  IPC Bridge    │  IPC Bridge                  │
├─────────┼────────────────┼──────────────────────────────┤
│  Electron Renderer Process                              │
│                                                         │
│  ┌────────────────┐  ┌──────────────────────────────┐   │
│  │ Sidebar        │  │ Terminal Panel               │   │
│  │ (state list)   │  │ (xterm.js per session)       │   │
│  └────────────────┘  └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### State Detection: JSONL Session Files

Claude Code writes a JSONL file per session at `~/.claude/projects/<encoded-path>/sessions/<uuid>.jsonl`. Each line is a typed event with a timestamp:

```jsonl
{"type":"user","message":{"role":"user","content":"..."},"timestamp":"...","uuid":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]},"timestamp":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_result",...}]},"timestamp":"..."}
```

Events include: user prompts, assistant responses, tool calls with full inputs/outputs, extended thinking blocks, subagent spawns, token usage, git snapshots.

**State derivation logic:**

| JSONL Signal | Derived State |
|---|---|
| Last event is `tool_use` and file still changing | **Working** — actively running tools |
| Last event is assistant text, no new writes for 5s+ | **Idle** — finished or waiting for user |
| Process exited with code 0 | **Done** |
| Process exited non-zero | **Error** |
| Last event is a permission/input prompt pattern | **Needs Input** |

**Write granularity:** Per-message, not per-token. A new line appears when a tool call is issued, when a tool result returns, when an assistant response completes. During extended thinking (10-30s), there's silence — we fall back to PTY byte activity to distinguish "thinking" from "stuck."

**Latency:** ~1-2 seconds for state transitions. `fs.watch` fires sub-100ms on file change. Good enough for a dashboard.

### Terminal: xterm.js + node-pty (Don't Fork, Compose)

**Don't fork a terminal app.** There's nothing to gain from forking Hyper or electerm — they're general-purpose terminal emulators, and you'd spend more time removing features than adding yours. Instead, compose from libraries:

- **xterm.js** — Terminal rendering in the browser/Electron renderer. This is what VS Code uses. It's a component, not an app. You drop it into a div.
- **node-pty** — Pseudoterminal bindings for Node. Spawns a real PTY process. This is what VS Code uses under the hood for its integrated terminal.
- **IPC bridge** — node-pty runs in Electron's main process (it's a native module). xterm.js runs in the renderer. They communicate via Electron IPC. The official node-pty repo has an [Electron example](https://github.com/microsoft/node-pty/blob/main/examples/electron/README.md) showing exactly this pattern.

The wiring is ~50 lines of code:

```
Main process:
  const pty = spawn('claude', [...], { cwd: worktreePath, env: scrubbedEnv })
  pty.onData(data => win.webContents.send('pty-data', sessionId, data))
  ipcMain.on('pty-input', (e, id, data) => sessions[id].pty.write(data))

Renderer:
  const term = new Terminal()
  term.open(containerEl)
  ipcRenderer.on('pty-data', (e, id, data) => { if (id === activeId) term.write(data) })
  term.onData(data => ipcRenderer.send('pty-input', activeId, data))
```

**Why node-pty and not child_process.spawn?** `child_process` doesn't allocate a real pseudoterminal. Claude Code detects this and may behave differently (no colors, no interactive prompts, different output format). node-pty gives Claude Code a real TTY, so it renders its full interactive UI: spinners, colored tool blocks, permission prompts, everything.

**Build concern:** node-pty is a native C++ addon requiring `electron-rebuild`. This is a one-time build step, not an ongoing headache. Add to package.json:

```json
{
  "scripts": {
    "postinstall": "electron-rebuild -f -w node-pty"
  }
}
```

---

## Staged Build Plan

### Stage 1: Terminal + JSONL Proof of Concept

**Goal:** Prove that JSONL watching works reliably for state detection alongside a real terminal. Minimal UI — just enough to validate the approach before building more.

**What you build:**

A single Electron window, split in two:
- **Right (70%):** A real xterm.js terminal running a Claude Code session
- **Left (30%):** A scrolling log of state changes derived from the JSONL session file

The sidebar is literally a reverse-chronological list of events:

```
12:34:02  🔧 Bash: npm test
12:34:00  📝 Write: src/auth.ts
12:33:45  📖 Read: src/auth.ts  
12:33:40  🤔 Thinking...
12:33:38  👤 User prompt submitted
```

At the top of the sidebar, show the derived state as a colored badge:

```
● Working — editing src/auth.ts     (green pulse)
◉ Needs Input — waiting 12s          (amber)  
✓ Done                                (blue)
✗ Error — exit code 1                (red)
```

**Implementation steps:**

1. **Scaffold Electron app** with your existing stack (Vite, React 19, Tailwind v4, electron-vite 5). You already have this from your current project — strip it down to basics.

2. **Wire up xterm.js + node-pty.** Install `xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, and `node-pty`. Create a `TerminalPanel` React component that initializes an xterm.js instance and connects it to a PTY process in the main process via IPC.

3. **Spawn Claude Code in the PTY.** In main process, resolve the `claude` binary (check `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, then `which claude`). Spawn with scrubbed env (remove all `CLAUDE*` vars to prevent nesting detection). Start it in a chosen working directory.

4. **Find and watch the JSONL file.** After spawning Claude, watch `~/.claude/projects/` for the session file. The directory name is the URL-encoded project path (slashes become dashes). The session file is `<uuid>.jsonl`. Use `fs.watch` (or `chokidar` for robustness) on the file. On each change, read new lines from the last-read position (tail behavior).

5. **Parse JSONL events and derive state.** Each line is a JSON object with `type`, `message`, `timestamp`, `uuid`. Parse the `message.content` array to find `tool_use`, `tool_result`, and `text` blocks. Derive the current state from the latest events. Send state updates to the renderer via IPC.

6. **Render the sidebar.** Simple React component: a state badge at top, a scrolling list of recent events below. Style with Tailwind. No kanban, no drag-and-drop, no fancy layout — just a log.

**What to validate:**
- Does `fs.watch` reliably fire when Claude writes to the JSONL? (Test on macOS — `fs.watch` can be flaky; you may need `chokidar` or `fsevents` directly.)
- How quickly do state transitions appear after Claude acts?
- Can you reliably distinguish "working" from "idle" from "needs input"?
- Does the terminal work perfectly? Can you type, use Claude's interactive features, see colors/spinners?
- Does the JSONL file path match what you expect given the working directory?

**What you explicitly don't build:**
- Multiple sessions / tabs
- Worktree management
- Kanban board
- Session spawning UI
- Any orchestration logic

**Kill criteria:** If JSONL watching is unreliable (events missing, file not found, format changes between Claude Code versions, macOS fs.watch not firing), stop and reconsider. The whole architecture depends on this working. Fallback: screen buffer inspection (check last line of xterm.js buffer every 2s for prompt patterns).

**Estimated effort:** 1-2 days for someone familiar with Electron + the existing codebase.

---

### Stage 2: Multi-Session Support

**Goal:** Run multiple Claude Code sessions simultaneously, each in its own PTY, each with its own JSONL watcher. Switch between them.

**What you build:**

- **Session manager in main process.** A Map of `sessionId → { pty, jsonlWatcher, state, worktreePath, events[] }`. Each session is independent.
- **Tab bar or list in sidebar.** Click to switch which terminal is shown on the right. Each entry shows: session name, current state badge, last activity timestamp.
- **Background PTY buffering.** When a session isn't active (not displayed), its PTY output still flows into a buffer. When you switch to it, replay the buffer into xterm.js so you see the full history. Use xterm.js's `SerializeAddon` for this — serialize the terminal state when switching away, restore when switching back.

**Session lifecycle:**
```
User clicks "New Session" →
  Main process: create git worktree, spawn PTY, start JSONL watcher →
  Renderer: add tab to sidebar, show terminal
  
User clicks different tab →
  Renderer: serialize current xterm state, hide terminal, show new one
  
Session process exits →
  Main process: update state to Done/Error, notify renderer
  Renderer: update sidebar badge
```

**What to validate:**
- Can you run 3-5 PTY processes simultaneously without performance issues?
- Does switching between sessions feel instant (no flicker, no lost state)?
- Do JSONL watchers for multiple sessions work independently?
- Memory usage with multiple xterm.js instances?

**Estimated effort:** 2-3 days.

---

### Stage 3: Worktree Integration + Session Spawning

**Goal:** Proper git worktree lifecycle. Users can spawn a new agent on an issue/branch with one click.

**What you build:**

- **"New Agent" flow:** User provides a branch name (or issue number). App runs `git worktree add .worktrees/<name> -b <branch>` in the project root. Spawns Claude in that worktree with an initial prompt.
- **Worktree list.** Sidebar shows all active worktrees with their state. Replace the simple tab list from Stage 2 with a proper session list showing branch, state, time active, last event summary.
- **Cleanup.** When a session is done and the user confirms, run `git worktree remove`. Handle the "changes exist" case gracefully.
- **Initial prompt injection.** When spawning, optionally pipe an initial prompt to Claude via PTY write (simulate typing). For example: "Implement feature X based on issue #123. Create a PR when done."

**Critical gotcha from CLAUDE.md:** Vite watches `.worktrees/` and triggers page reload. Add to `electron.vite.config.js`:

```js
server: {
  watch: {
    ignored: ['**/.worktrees/**']
  }
}
```

**Estimated effort:** 2-3 days.

---

### Stage 4: Orchestration Layer

**Goal:** The app actively helps manage agents, not just display them. This is where you differentiate from tmux + scripts.

**What you build:**

- **Attention zones.** Group sessions by what needs human attention: "Needs Input" (top), "Working" (middle), "Done / Ready for Review" (bottom). This is the kanban-lite view from your original design, but driven by real state data.
- **Notifications.** Desktop notifications when a session transitions to "Needs Input" or "Error." Badge count in dock/taskbar.
- **Cross-session awareness.** Detect when two agents are editing the same file (watch git status across worktrees). Surface a warning.
- **CI integration (stretch).** Poll GitHub Actions / PR status for each branch. Show "CI passing" / "CI failing" alongside session state. Route CI failure logs to the agent (write to PTY).

**This is where the Composio insights apply.** The value isn't monitoring — it's closing the feedback loop. CI fails → agent gets the logs automatically. Review comments → routed to agent. The human only gets pulled in for judgment calls.

**Estimated effort:** 1-2 weeks.

---

### Stage 5: Polish + Advanced Features

- **Resizable split layout.** Drag handle between sidebar and terminal. Remember size.
- **Search across sessions.** Full-text search over JSONL transcripts.
- **Cost tracking.** JSONL includes token usage per turn. Sum and display per-session cost.
- **Session replay.** Load a completed session's JSONL and replay the timeline.
- **Claude Code hooks integration.** Register hooks (PreToolUse, PostToolUse, Stop) that write to a named pipe. Gives sub-second tool-level events that complement the JSONL watcher.
- **MCP `requestGuidance` server.** Build a small MCP server exposing a `requestGuidance(question)` tool. Configure each Claude session to connect. When Claude calls it, show the question in the UI with an input field. User's answer gets returned as the tool result. Solves the `AskUserQuestion` problem cleanly.

---

## Tech Stack

Carry forward from your existing project:

| Layer | Choice | Notes |
|---|---|---|
| Shell | Electron (electron-vite 5, Vite 7) | `electron.vite.config.js` (dot-separated) |
| Frontend | React 19 + Tailwind CSS v4 | `@theme` in CSS, no config file |
| Terminal | xterm.js + @xterm/addon-fit + @xterm/addon-serialize | Renderer process |
| PTY | node-pty | Main process, needs `electron-rebuild` |
| File watching | chokidar (or fs.watch + fsevents fallback) | For JSONL session files |
| IPC | contextBridge + ipcRenderer/ipcMain | Standard Electron pattern |
| State | In-memory in main process | No database needed |
| Fonts | Inter (UI) + JetBrains Mono (terminal) | Already in your project |
| Process mgmt | Main process spawns/kills PTY processes | `before-quit` → kill all |

---

## Critical Gotchas (Carry Forward)

These are from your existing CLAUDE.md and still apply:

1. **Claude nesting detection.** Scrub ALL `CLAUDE*` env vars (`CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, etc.) from the environment before spawning child Claude processes. Without this, Claude detects it's inside another Claude session and hangs silently.

2. **Vite watches worktree files.** Ignore `.worktrees/**` in the Vite dev server watch config or you'll get constant page reloads destroying renderer state.

3. **Electron main process doesn't inherit shell env on macOS.** GUI-launched apps don't get full `$PATH`. Resolve `claude` binary via explicit path checks (`~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`) then fall back to `which claude`. Spawn through `/bin/sh -c`, not a login shell.

4. **Process cleanup on quit.** Kill all spawned PTY processes on Electron's `before-quit` event. node-pty processes don't die automatically when the parent exits.

5. **Preload scripts.** Build as `.mjs` with electron-vite 5.

6. **JSONL path encoding.** The project directory path is encoded with dashes replacing slashes: `/Users/me/myproject` becomes `-Users-me-myproject` under `~/.claude/projects/`.

7. **JSONL deduplication.** Claude Code sometimes writes the same message (same UUID) to multiple files during branching or resumption. Deduplicate by UUID.

---

## JSONL Schema Reference

Based on reverse-engineering and community tools. This is **not a stable API** — it could change with any Claude Code update.

### File Location
```
~/.claude/
├── projects/
│   └── <url-encoded-project-path>/
│       └── sessions/
│           ├── <session-uuid>.jsonl     ← conversation transcript
│           └── ...
├── history.jsonl                        ← global index (metadata only)
└── session-env/                         ← session environment data
```

### Event Structure (each JSONL line)

```typescript
interface SessionEvent {
  type: 'user' | 'assistant' | 'system' | 'summary';
  message: {
    role: 'user' | 'assistant' | 'system';
    content: ContentBlock[] | string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  uuid: string;
  parentUuid?: string;
  sessionId: string;
  timestamp: string;       // ISO-8601
  version?: string;        // Claude Code version
  gitBranch?: string;
  cwd?: string;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
  | { type: 'tool_result'; tool_use_id: string; content: any }
  | { type: 'thinking'; thinking: string };
```

### Tool Names to Watch For

| Tool Name | What It Means |
|---|---|
| `Read` | Reading a file |
| `Write` | Writing/creating a file |
| `Bash` | Running a shell command (input.command has the command) |
| `Task` | Spawning a subagent |
| `WebSearch` | Searching the web |

---

## Open Questions

1. **JSONL path for worktrees.** When Claude runs inside a worktree (`.worktrees/feat-auth/`), does the JSONL path use the worktree path or the main repo path? Needs testing.

2. **Session file discovery timing.** When you spawn Claude, how quickly does the JSONL file appear? Is there a race condition where you start watching before the file exists? May need a polling loop on startup.

3. **`--resume` across sessions.** If you want to resume a previous Claude session in a new PTY, `claude --resume <session-id>` creates a new JSONL file. Your watcher needs to handle this (watch for new files in the session directory, not just changes to one file).

4. **Hooks as complement to JSONL.** Claude Code hooks (`PreToolUse`, `PostToolUse`, `Stop`) fire *before* the JSONL is written. If sub-second latency matters for specific events (like "Claude is about to delete a file"), hooks could write to a named pipe that the main process reads. Worth exploring in Stage 5 but not essential earlier.

5. **node-pty alternatives.** If `electron-rebuild` for node-pty becomes a maintenance burden, consider running a sidecar process (separate Node.js process managing PTYs) that communicates with Electron over a local socket. Keeps the Electron app native-module-free. Over-engineering for now, but noted.

---

## Getting Started (Stage 1 Checklist)

```bash
# 1. Set up the Electron project (or strip your existing one)
npm create electron-vite@latest orchestrator -- --template react-ts
cd orchestrator

# 2. Install terminal dependencies
npm install xterm @xterm/addon-fit @xterm/addon-serialize @xterm/addon-web-links
npm install node-pty
npm install -D electron-rebuild
npx electron-rebuild -f -w node-pty

# 3. Install file watching
npm install chokidar

# 4. Verify Claude Code writes JSONL
# Run Claude Code normally in any project, then:
ls ~/.claude/projects/
# Find your project's encoded directory, look for .jsonl files in sessions/
# Tail one while Claude works:
tail -f ~/.claude/projects/<your-project>/sessions/<latest>.jsonl | jq .

# 5. Build Stage 1
# - Main process: PTY manager + JSONL watcher
# - Preload: IPC bridge for pty-data, pty-input, state-update channels
# - Renderer: Split layout with TerminalPanel + StateLog sidebar
```

If `tail -f` on the JSONL shows events flowing in real-time as Claude works — you're good. Build the app. If it doesn't, investigate before writing any code.