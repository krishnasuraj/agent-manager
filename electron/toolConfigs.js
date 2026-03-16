// Tool Config Registry — agent-agnostic configuration for each supported coding tool.
// Each config provides binary paths, JSONL schemas, PTY detection patterns, and parsers.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'

// ─── Shared helpers ──────────────────────────────────────────────

function findBinary(candidates, fallbackCmd) {
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch { /* ignore */ }
  }
  try {
    const resolved = execSync(`which ${fallbackCmd}`, { encoding: 'utf8', timeout: 3000 }).trim()
    if (resolved) return resolved
  } catch { /* ignore */ }
  return fallbackCmd
}

// ─── Claude Code ─────────────────────────────────────────────────

const claude = {
  id: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',

  findBinary() {
    return findBinary([
      `${os.homedir()}/.local/bin/claude`,
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ], 'claude')
  },

  envPrefixToScrub: 'CLAUDE',

  // JSONL session file location
  sessionRoot: path.join(os.homedir(), '.claude', 'projects'),
  watchDepth: 1,

  encodeProjectPath(dirPath) {
    return dirPath.replace(/[/_.]/g, '-')
  },

  getProjectDir(cwd) {
    return path.join(this.sessionRoot, this.encodeProjectPath(cwd))
  },

  // PTY detection patterns
  startupPatterns: [
    /╭|Claude Code/,
    /[*✶✻✽✳✢⏺·]\s*[A-Z][a-z]+[.…]/,  // thinking spinner also means Claude is running
  ],
  permissionPatterns: [
    /Allow\s+Deny/i,
    /[❯›]\s*(Allow|Yes)/,
    /Allow once/i,
    /Allow always/i,
    /Yes.*don['\u2019]t ask again/i,
    /Do you want to (?:allow|create|delete|execute|run|open|remove)/i,
    /\d+\.\s*Yes[,\s]/,
  ],
  thinkingPatterns: [
    /[*✶✻✽✳✢⏺·]\s*[A-Z][a-z]+[.…]/,
  ],

  // Tools that never show permission prompts (always auto-approved).
  // These should never trigger "needs-input" via the stale timer.
  autoApprovedTools: new Set([
    'Agent', 'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'TaskOutput',
  ]),

  // JSONL meaningful event types
  meaningfulTypes: new Set(['user', 'assistant', 'system', 'result']),

  isNoiseEvent(event) {
    return !this.meaningfulTypes.has(event.type)
  },

  isSessionEndEvent(event) {
    return event.type === 'result'
  },

  // State derivation from JSONL events
  deriveState(events, lastWriteTime, lastThinkingTime) {
    if (events.length === 0) return { state: 'idle', summary: 'Waiting...' }

    let last = null
    for (let i = events.length - 1; i >= 0; i--) {
      if (this.meaningfulTypes.has(events[i].type)) {
        last = events[i]
        break
      }
    }
    if (!last) return { state: 'idle', summary: 'Waiting...' }

    const now = Date.now()
    const timeSinceWrite = now - lastWriteTime

    if (last.type === 'assistant' && last.message?.content) {
      const content = Array.isArray(last.message.content) ? last.message.content : []

      const toolUses = content.filter((b) => b.type === 'tool_use')
      if (toolUses.length > 0) {
        const lastTool = toolUses[toolUses.length - 1]
        if (timeSinceWrite > 5000) {
          // Auto-approved tools (Agent, Task*, etc.) never show permission
          // prompts, so they should never trigger needs-input.
          if (this.autoApprovedTools.has(lastTool.name)) {
            return { state: 'working', summary: `Running: ${lastTool.name}` }
          }
          // If PTY detected a thinking spinner recently, Claude is actively
          // working (not waiting for approval). Suppress the needs-input state.
          const thinkingAge = lastThinkingTime ? (now - lastThinkingTime) : Infinity
          if (thinkingAge < 15000) {
            return { state: 'working', summary: 'Thinking...' }
          }
          return { state: 'needs-input', summary: `Waiting for approval: ${lastTool.name}` }
        }
        return { state: 'working', summary: `${lastTool.name}: ${formatClaudeToolInput(lastTool)}` }
      }

      if (content.some((b) => b.type === 'thinking')) {
        return { state: 'working', summary: 'Thinking...' }
      }

      const textBlocks = content.filter((b) => b.type === 'text')
      if (textBlocks.length > 0 && timeSinceWrite < 5000) {
        return { state: 'working', summary: 'Responding...' }
      }

      return { state: 'idle', summary: 'Finished response' }
    }

    if (last.type === 'assistant' && last.message?.stop_reason === 'end_turn' && timeSinceWrite > 5000) {
      return { state: 'idle', summary: 'Waiting for prompt' }
    }

    if (last.type === 'user' || last.type === 'assistant') {
      const content = Array.isArray(last.message?.content) ? last.message.content : []
      if (content.some((b) => b.type === 'tool_result')) {
        return { state: 'working', summary: 'Processing tool result...' }
      }
    }

    if (last.type === 'user') {
      if (timeSinceWrite > 5000) {
        return { state: 'idle', summary: 'Waiting for prompt' }
      }
      return { state: 'working', summary: 'Processing prompt...' }
    }

    return { state: 'idle', summary: '' }
  },

  // JSONL event → sidebar log entry
  eventToLogEntry(event) {
    const timestamp = event.timestamp
      ? new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false })
      : ''

    if (event.type === 'user') {
      const content = event.message?.content
      if (typeof content === 'string') {
        return { timestamp, icon: '👤', label: 'User prompt', detail: content.slice(0, 80), expanded: content }
      }
      const blocks = Array.isArray(content) ? content : []
      if (blocks.some((b) => b.type === 'tool_result')) {
        const results = blocks.filter((b) => b.type === 'tool_result')
        const expandedText = results.map((r) => formatToolResultContent(r.content)).join('\n---\n')
        return { timestamp, icon: '✅', label: 'Tool result', detail: `${results.length} result(s)`, expanded: expandedText }
      }
      return { timestamp, icon: '👤', label: 'User', detail: '' }
    }

    if (event.type === 'assistant') {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : []

      const toolUses = blocks.filter((b) => b.type === 'tool_use')
      if (toolUses.length > 0) {
        return toolUses.map((t) => ({
          timestamp,
          icon: CLAUDE_TOOL_ICONS[t.name] || '🔧',
          label: t.name,
          detail: formatClaudeToolInput(t),
          expanded: JSON.stringify(t.input || {}, null, 2),
        }))
      }

      const thinkingBlock = blocks.find((b) => b.type === 'thinking')
      if (thinkingBlock) {
        return { timestamp, icon: '🤔', label: 'Thinking', detail: '', expanded: thinkingBlock.thinking || '' }
      }

      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (text) {
        return { timestamp, icon: '💬', label: 'Response', detail: text.slice(0, 80), expanded: text }
      }
    }

    if (event.type === 'system') {
      const content = event.message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((b) => b.type === 'text').map((b) => b.text).join('')
        : ''
      return { timestamp, icon: '⚙️', label: 'System', detail: '', expanded: text || undefined }
    }

    return null
  },

  // JSONL file routing: match file to session by encoded cwd
  matchFileToSession(filePath, sessionStates) {
    const fileProjectDir = path.dirname(filePath)
    for (const [sessionId, state] of sessionStates) {
      if (state.locked) continue
      if (state.toolId !== 'claude') continue
      if (this.getProjectDir(state.cwd) === fileProjectDir) {
        return sessionId
      }
    }
    return null
  },

  // Snapshot all existing .jsonl files
  snapshotFiles() {
    const files = new Map()
    try {
      for (const dir of fs.readdirSync(this.sessionRoot)) {
        const dirPath = path.join(this.sessionRoot, dir)
        try {
          const stat = fs.statSync(dirPath)
          if (!stat.isDirectory()) continue
          for (const f of fs.readdirSync(dirPath)) {
            if (f.endsWith('.jsonl')) {
              const filePath = path.join(dirPath, f)
              try {
                files.set(filePath, fs.statSync(filePath).size)
              } catch { files.set(filePath, 0) }
            }
          }
        } catch { /* */ }
      }
    } catch { /* */ }
    return files
  },

  // Re-snapshot a specific session's project dir
  resnapshotForSession(state) {
    const projectDir = this.getProjectDir(state.cwd)
    try {
      for (const f of fs.readdirSync(projectDir)) {
        if (f.endsWith('.jsonl')) {
          const filePath = path.join(projectDir, f)
          try {
            state.knownFiles.set(filePath, fs.statSync(filePath).size)
          } catch { /* */ }
        }
      }
    } catch { /* */ }
  },
}

const CLAUDE_TOOL_ICONS = {
  Read: '📖', Write: '📝', Edit: '✏️', Bash: '⚡',
  Glob: '🔍', Grep: '🔍', WebFetch: '🌐', WebSearch: '🔎',
  Agent: '🤖', Task: '🤖',
}

function formatClaudeToolInput(toolUse) {
  const input = toolUse.input || {}
  switch (toolUse.name) {
    case 'Read':
    case 'Write':
    case 'Edit': return input.file_path ? path.basename(input.file_path) : ''
    case 'Bash': return (input.command || '').slice(0, 60)
    case 'Glob':
    case 'Grep': return input.pattern || ''
    default: return ''
  }
}

function formatToolResultContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b
        if (b.type === 'text') return b.text
        return JSON.stringify(b)
      })
      .join('\n')
  }
  return JSON.stringify(content, null, 2)
}

// ─── Codex CLI ───────────────────────────────────────────────────

const codex = {
  id: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',

  findBinary() {
    return findBinary([
      `${os.homedir()}/.local/bin/codex`,
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    ], 'codex')
  },

  envPrefixToScrub: null,  // Codex doesn't have documented nesting env vars

  // JSONL session file location
  sessionRoot: path.join(os.homedir(), '.codex', 'sessions'),
  watchDepth: 4,  // YYYY/MM/DD/rollout-*.jsonl

  // PTY detection patterns.
  // Ratatui full-screen redraws garble ANSI-stripped output, so PTY pattern
  // matching is unreliable for Codex. Working/thinking state comes from JSONL
  // events instead. Permission detection also uses JSONL (stale function_call).
  startupPatterns: [
    /OpenAI Codex/,    // Header text that appears on launch
    /codex/i,          // Command echo before TUI starts
  ],
  permissionPatterns: [],  // Not used — Codex permissions detected via JSONL stale timer
  thinkingPatterns: [],    // Not used — Codex working state comes from JSONL events

  // Startup cooldown: after detecting Codex start, ignore shell return for this
  // many ms. Codex takes a moment to enter the alternate screen, and the shell
  // prompt is still visible in the buffer during that time.
  startupCooldownMs: 3000,

  // Codex JSONL event types that carry meaningful conversation state
  meaningfulEventMsgTypes: new Set([
    'user_message', 'agent_message', 'agent_reasoning',
    'task_started', 'task_complete', 'turn_aborted',
  ]),

  isNoiseEvent(event) {
    // Top-level types that are always noise
    if (event.type === 'response_item') {
      const pt = event.payload?.type
      // function_call and custom_tool_call are meaningful
      if (pt === 'function_call' || pt === 'custom_tool_call') return false
      // function_call_output and custom_tool_call_output are meaningful
      if (pt === 'function_call_output' || pt === 'custom_tool_call_output') return false
      return true  // message, reasoning are noise for state derivation
    }
    if (event.type === 'session_meta' || event.type === 'turn_context') return true
    if (event.type === 'event_msg') {
      return !this.meaningfulEventMsgTypes.has(event.payload?.type)
    }
    return true
  },

  // Codex "task_complete" is per-turn, not per-session. The session only ends
  // when the user quits codex (detected via shell prompt return in ptyManager).
  isSessionEndEvent() {
    return false
  },

  // State derivation from Codex JSONL events.
  // Unlike Claude, Codex has explicit turn lifecycle events (task_started,
  // task_complete), so we derive state directly from the last event type
  // without relying on stale timers. The only exception: function_call with
  // no function_call_output after 3s indicates an approval prompt.
  deriveState(events, lastWriteTime) {
    if (events.length === 0) return { state: 'idle', summary: 'Waiting...' }

    // Find the last meaningful event
    let last = null
    for (let i = events.length - 1; i >= 0; i--) {
      if (!this.isNoiseEvent(events[i])) {
        last = events[i]
        break
      }
    }
    if (!last) return { state: 'idle', summary: 'Waiting...' }

    const now = Date.now()
    const timeSinceWrite = now - lastWriteTime

    // event_msg types
    if (last.type === 'event_msg') {
      const pt = last.payload?.type

      if (pt === 'task_complete') {
        return { state: 'idle', summary: 'Finished response' }
      }
      if (pt === 'turn_aborted') {
        return { state: 'idle', summary: 'Interrupted' }
      }
      if (pt === 'task_started') {
        return { state: 'working', summary: 'Processing...' }
      }
      if (pt === 'user_message') {
        return { state: 'working', summary: 'Processing prompt...' }
      }
      // agent_message = working, but if 15s+ pass with no new JSONL writes,
      // the turn likely completed and we missed task_complete. Fall back to idle.
      if (pt === 'agent_message') {
        if (timeSinceWrite > 15000) return { state: 'idle', summary: 'Finished response' }
        return { state: 'working', summary: 'Responding...' }
      }
      if (pt === 'agent_reasoning') {
        return { state: 'working', summary: 'Thinking...' }
      }
    }

    // response_item types
    if (last.type === 'response_item') {
      const pt = last.payload?.type
      if (pt === 'function_call' || pt === 'custom_tool_call') {
        const name = last.payload?.name || 'tool'
        // Approval prompt detection via stale timer (PTY patterns don't work
        // for Ratatui). 3s is enough — Codex writes function_call_output
        // immediately after execution, so a gap means user is being prompted.
        if (timeSinceWrite > 3000) {
          return { state: 'needs-input', summary: `Waiting for approval: ${name}` }
        }
        return { state: 'working', summary: `Running: ${name}` }
      }
      if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
        return { state: 'working', summary: 'Processing tool result...' }
      }
    }

    return { state: 'idle', summary: '' }
  },

  // JSONL event → sidebar log entry
  eventToLogEntry(event) {
    const timestamp = event.timestamp
      ? new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false })
      : ''

    if (event.type === 'event_msg') {
      const pt = event.payload?.type

      if (pt === 'user_message') {
        const msg = event.payload?.message || ''
        return { timestamp, icon: '👤', label: 'User prompt', detail: msg.slice(0, 80), expanded: msg }
      }
      if (pt === 'agent_message') {
        const msg = event.payload?.message || ''
        return { timestamp, icon: '💬', label: 'Response', detail: msg.slice(0, 80), expanded: msg }
      }
      if (pt === 'agent_reasoning') {
        const text = event.payload?.text || ''
        return { timestamp, icon: '🤔', label: 'Thinking', detail: text.slice(0, 80), expanded: text }
      }
      if (pt === 'task_started') {
        return { timestamp, icon: '▶️', label: 'Turn started', detail: '' }
      }
      if (pt === 'task_complete') {
        return { timestamp, icon: '✅', label: 'Turn complete', detail: '' }
      }
      if (pt === 'turn_aborted') {
        return { timestamp, icon: '⏹️', label: 'Interrupted', detail: event.payload?.reason || '' }
      }
    }

    if (event.type === 'response_item') {
      const pt = event.payload?.type
      if (pt === 'function_call') {
        const name = event.payload?.name || 'command'
        let detail = ''
        try {
          const args = JSON.parse(event.payload?.arguments || '{}')
          detail = (args.cmd || '').slice(0, 60)
        } catch { /* */ }
        return { timestamp, icon: '⚡', label: name, detail, expanded: event.payload?.arguments }
      }
      if (pt === 'custom_tool_call') {
        return { timestamp, icon: '🔧', label: event.payload?.name || 'tool', detail: '' }
      }
      if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
        const output = event.payload?.output || ''
        return { timestamp, icon: '✅', label: 'Tool result', detail: output.slice(0, 60), expanded: output }
      }
      if (pt === 'web_search_call') {
        return { timestamp, icon: '🔎', label: 'Web search', detail: '' }
      }
    }

    return null
  },

  // JSONL file routing: Codex uses date-based paths, not cwd-encoded paths.
  // We read the session_meta event from the file to get the cwd, then match.
  matchFileToSession(filePath, sessionStates) {
    // The session_meta first line is huge (includes full system prompt),
    // so we can't JSON.parse a 4KB buffer. Instead, extract "cwd" with a regex
    // from the first chunk — it appears early in the payload before base_instructions.
    let fileCwd = null
    try {
      const fd = fs.openSync(filePath, 'r')
      const buf = Buffer.alloc(1024)
      const bytesRead = fs.readSync(fd, buf, 0, 1024, 0)
      fs.closeSync(fd)
      const head = buf.toString('utf8', 0, bytesRead)
      // Match "cwd":"/some/path" — the first occurrence is in session_meta.payload
      const cwdMatch = head.match(/"cwd"\s*:\s*"([^"]+)"/)
      if (cwdMatch) {
        fileCwd = cwdMatch[1]
      }
    } catch { /* */ }

    if (!fileCwd) return null

    for (const [sessionId, state] of sessionStates) {
      if (state.locked) continue
      if (state.toolId !== 'codex') continue
      if (state.cwd === fileCwd) {
        return sessionId
      }
    }
    return null
  },

  // Snapshot all existing .jsonl files under the sessions root
  snapshotFiles() {
    const files = new Map()
    const root = this.sessionRoot
    try {
      // Walk YYYY/MM/DD directories
      for (const year of fs.readdirSync(root)) {
        const yearPath = path.join(root, year)
        try {
          if (!fs.statSync(yearPath).isDirectory()) continue
          for (const month of fs.readdirSync(yearPath)) {
            const monthPath = path.join(yearPath, month)
            try {
              if (!fs.statSync(monthPath).isDirectory()) continue
              for (const day of fs.readdirSync(monthPath)) {
                const dayPath = path.join(monthPath, day)
                try {
                  if (!fs.statSync(dayPath).isDirectory()) continue
                  for (const f of fs.readdirSync(dayPath)) {
                    if (f.endsWith('.jsonl')) {
                      const filePath = path.join(dayPath, f)
                      try {
                        files.set(filePath, fs.statSync(filePath).size)
                      } catch { files.set(filePath, 0) }
                    }
                  }
                } catch { /* */ }
              }
            } catch { /* */ }
          }
        } catch { /* */ }
      }
    } catch { /* */ }
    return files
  },

  // Re-snapshot: just re-read today's directory (most likely location for new files)
  resnapshotForSession(state) {
    const now = new Date()
    const dayDir = path.join(
      this.sessionRoot,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    )
    try {
      if (!fs.statSync(dayDir).isDirectory()) return
      for (const f of fs.readdirSync(dayDir)) {
        if (f.endsWith('.jsonl')) {
          const filePath = path.join(dayDir, f)
          try {
            state.knownFiles.set(filePath, fs.statSync(filePath).size)
          } catch { /* */ }
        }
      }
    } catch { /* */ }
  },
}

// ─── Registry ────────────────────────────────────────────────────

const toolConfigs = { claude, codex }

export function getToolConfig(toolId) {
  return toolConfigs[toolId] || toolConfigs.claude
}

export function getAllToolConfigs() {
  return Object.values(toolConfigs)
}

export function getAvailableTools() {
  return Object.values(toolConfigs).map(t => ({
    id: t.id,
    displayName: t.displayName,
    binary: t.binary,
  }))
}
