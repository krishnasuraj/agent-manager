// JSONL Session Watcher — watches Claude Code's session JSONL files for state.
//
// Claude Code writes a JSONL file per session at:
//   ~/.claude/projects/<encoded-path>/<uuid>.jsonl
//
// The encoded path replaces slashes and underscores with dashes:
//   /Users/me/my_project → -Users-me-my-project
//
// Architecture: ONE global chokidar watcher for all sessions. Each file-change
// event fires a single callback that routes to the owning session. This eliminates
// the race condition that occurred with N independent watchers all watching the
// same directory — where a non-deterministic callback ordering caused the wrong
// session to claim a JSONL file.
//
// File assignment: when a new JSONL file starts growing, match the session whose
// cwd matches the file's project directory. No fallback — each session must have
// a unique cwd (guaranteed by worktree isolation).

import fs from 'fs'
import path from 'path'
import os from 'os'
import { watch } from 'chokidar'

// Event types that carry meaningful conversation state
const MEANINGFUL_TYPES = new Set(['user', 'assistant', 'system', 'result'])

// Max events kept in memory per session — only the tail matters for state derivation
const MAX_EVENTS = 50

/**
 * Derive the state from the latest JSONL events.
 */
function deriveState(events, lastWriteTime) {
  if (events.length === 0) return { state: 'idle', summary: 'Waiting...' }

  // Skip non-meaningful events (file-history-snapshot, progress, queue-operation, etc.)
  // to find the last actual conversation event
  let last = null
  for (let i = events.length - 1; i >= 0; i--) {
    if (MEANINGFUL_TYPES.has(events[i].type)) {
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
      // Tool was called but no result yet — if file hasn't changed in 5s,
      // Claude is likely waiting for permission approval
      if (timeSinceWrite > 5000) {
        return { state: 'needs-input', summary: `Waiting for approval: ${lastTool.name}` }
      }
      return { state: 'working', summary: `${lastTool.name}: ${formatToolInput(lastTool)}` }
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

  // Last event is assistant end_turn with no tool calls and file went quiet — idle/waiting for user
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
    // If 5s+ since last write and no thinking spinner detected (notifyThinking
    // would have overridden state), Claude has finished processing and is idle.
    // Thinking spinners appear within 1-2s, so 5s of silence is a safe threshold.
    if (timeSinceWrite > 5000) {
      return { state: 'idle', summary: 'Waiting for prompt' }
    }
    return { state: 'working', summary: 'Processing prompt...' }
  }

  return { state: 'idle', summary: '' }
}

function formatToolInput(toolUse) {
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

function eventToLogEntry(event) {
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
        icon: toolIcon(t.name),
        label: t.name,
        detail: formatToolInput(t),
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
}

const TOOL_ICONS = {
  Read: '📖', Write: '📝', Edit: '✏️', Bash: '⚡',
  Glob: '🔍', Grep: '🔍', WebFetch: '🌐', WebSearch: '🔎',
  Agent: '🤖', Task: '🤖',
}

function toolIcon(name) {
  return TOOL_ICONS[name] || '🔧'
}

// ─── Exported module ─────────────────────────────────────────────

export function createJsonlWatcher(getWindow) {
  // One chokidar instance for all sessions
  let globalWatcher = null

  // sessionId → per-session state
  const sessionStates = new Map()

  // filePath → sessionId: which session owns each JSONL file
  const fileOwners = new Map()

  function sendToRenderer(channel, ...args) {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }

  function encodeProjectPath(dirPath) {
    return dirPath.replace(/[/_.]/g, '-')
  }

  function getProjectDir(cwd) {
    return path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(cwd))
  }

  function getProjectsRoot() {
    return path.join(os.homedir(), '.claude', 'projects')
  }

  /**
   * Snapshot all existing .jsonl files across ALL project dirs.
   * Returns a Map of full path → file size in bytes.
   */
  function snapshotFiles() {
    const root = getProjectsRoot()
    const files = new Map()
    try {
      for (const dir of fs.readdirSync(root)) {
        const dirPath = path.join(root, dir)
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
  }

  /**
   * Route a file-change event to the correct session.
   * Called once per change event — no race between multiple watchers.
   */
  function routeFileChange(filePath) {
    // Route to the session that already owns this file
    const ownerId = fileOwners.get(filePath)
    if (ownerId) {
      const state = sessionStates.get(ownerId)
      if (state) {
        processChange(ownerId, state, filePath)
      }
      return
    }

    const fileProjectDir = path.dirname(filePath)

    // Match the session whose spawn cwd maps to this file's project dir.
    // Each session has a unique worktree cwd, so this is a precise match.
    // No fallback pass — prevents "crossed wires" where an unlocked session
    // steals JSONL events meant for a different session.
    for (const [sessionId, state] of sessionStates) {
      if (state.locked) continue
      if (getProjectDir(state.cwd) !== fileProjectDir) continue
      if (tryClaimFile(sessionId, state, filePath)) return
    }
  }

  /**
   * Attempt to lock sessionId onto filePath. Returns true if successful.
   */
  function tryClaimFile(sessionId, state, filePath) {
    const snapshotSize = state.knownFiles.get(filePath)
    if (snapshotSize === undefined) return false

    let currentSize
    try { currentSize = fs.statSync(filePath).size } catch { return false }
    if (currentSize <= snapshotSize) return false

    const isResume = snapshotSize > 0
    console.log(`[jsonlWatcher:${sessionId}] LOCKED to ${isResume ? 'resumed' : 'new'} session file: ${path.basename(filePath)} (${snapshotSize} → ${currentSize})`)
    fileOwners.set(filePath, sessionId)
    state.filePath = filePath
    state.bytesRead = isResume ? 0 : snapshotSize
    state.locked = true
    sendToRenderer('jsonl:session-started', sessionId)
    readNewLines(sessionId, state)
    return true
  }

  /**
   * Process a change event for a session that already owns the file.
   */
  function processChange(sessionId, state, filePath) {
    if (filePath !== state.filePath) return

    state.lastWriteTime = Date.now()
    readNewLines(sessionId, state)

    clearTimeout(state.staleTimer)
    state.staleTimer = setTimeout(() => {
      const derived = deriveState(state.events, state.lastWriteTime)
      if (derived.state === 'idle') {
        setTimeout(() => sendToRenderer('jsonl:state', sessionId, derived), 1000)
      } else {
        sendToRenderer('jsonl:state', sessionId, derived)
      }
    }, 5000)
  }

  /**
   * Start watching for JSONL events for a session.
   *
   * @param {string} sessionId
   * @param {object} opts
   * @param {Map<string,number>} [opts.existingFiles] - Snapshot from before spawn
   * @param {string} [opts.cwd] - Working directory of this session's shell
   */
  function startWatching(sessionId, opts = {}) {
    const projectsRoot = getProjectsRoot()
    const { existingFiles, cwd } = opts

    const state = {
      events: [],
      bytesRead: 0,
      filePath: null,
      lastWriteTime: Date.now(),
      staleTimer: null,
      locked: false,
      knownFiles: existingFiles || new Map(),
      cwd: cwd || process.cwd(),
    }

    sessionStates.set(sessionId, state)
    console.log(`[jsonlWatcher:${sessionId}] registered (cwd: ${state.cwd})`)

    // Start the single global watcher on first session
    if (!globalWatcher) {
      if (!fs.existsSync(projectsRoot)) {
        try { fs.mkdirSync(projectsRoot, { recursive: true }) } catch { /* */ }
      }

      console.log(`[jsonlWatcher] starting global watcher on ${projectsRoot}`)

      globalWatcher = watch(projectsRoot, {
        ignoreInitial: false,
        awaitWriteFinish: false,
        depth: 1,
      })

      globalWatcher.on('add', (filePath) => {
        if (!filePath.endsWith('.jsonl')) return
        // Register new files in every session's knownFiles so they can claim it
        for (const [, s] of sessionStates) {
          if (!s.knownFiles.has(filePath)) {
            s.knownFiles.set(filePath, 0)
          }
        }
      })

      globalWatcher.on('change', (filePath) => {
        if (!filePath.endsWith('.jsonl')) return
        routeFileChange(filePath)
      })
    }
  }

  function readNewLines(sessionId, state) {
    if (!state.filePath) return

    let fileSize
    try {
      fileSize = fs.statSync(state.filePath).size
    } catch { return }

    if (fileSize <= state.bytesRead) return

    const stream = fs.createReadStream(state.filePath, {
      start: state.bytesRead,
      encoding: 'utf8',
    })

    let buffer = ''
    stream.on('data', (chunk) => { buffer += chunk })

    stream.on('end', () => {
      state.bytesRead = fileSize

      const newEvents = []
      for (const line of buffer.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          state.events.push(event)
          if (state.events.length > MAX_EVENTS) {
            state.events = state.events.slice(-MAX_EVENTS)
          }
          newEvents.push(event)
        } catch { /* incomplete line */ }
      }

      if (newEvents.length > 0) {
        for (const event of newEvents) {
          const entry = eventToLogEntry(event)
          if (entry) {
            const entries = Array.isArray(entry) ? entry : [entry]
            for (const e of entries) {
              sendToRenderer('jsonl:event', sessionId, e)
            }
          }

          // Detect Claude session end — the "result" event means Claude exited cleanly
          if (event.type === 'result') {
            console.log(`[jsonlWatcher:${sessionId}] result event — session ended`)
            sendToRenderer('jsonl:state', sessionId, { state: 'done', summary: 'Session complete' })
            sendToRenderer('jsonl:session-ended', sessionId)
            unlockSession(sessionId, state)
            return
          }
        }

        const derived = deriveState(state.events, state.lastWriteTime)
        sendToRenderer('jsonl:state', sessionId, derived)
      }
    })
  }

  /**
   * Release a session's lock on its JSONL file so it can pick up the next session.
   */
  function unlockSession(sessionId, state) {
    if (state.filePath) {
      fileOwners.delete(state.filePath)
    }
    state.locked = false
    state.filePath = null
    state.events = []
    clearTimeout(state.staleTimer)
    state.staleTimer = null
    // Re-snapshot only the session's own project dir, not the entire ~/.claude/projects/
    const projectDir = getProjectDir(state.cwd)
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
  }

  function notifyExit(sessionId, exitCode) {
    const state = sessionStates.get(sessionId)
    if (!state) return
    const derived = exitCode === 0
      ? { state: 'done', summary: 'Session complete' }
      : { state: 'error', summary: `Exit code ${exitCode}` }
    sendToRenderer('jsonl:state', sessionId, derived)
  }

  function notifyThinking(sessionId) {
    const state = sessionStates.get(sessionId)
    if (!state) return

    clearTimeout(state.staleTimer)
    state.staleTimer = setTimeout(() => {
      const derived = deriveState(state.events, state.lastWriteTime)
      sendToRenderer('jsonl:state', sessionId, derived)
    }, 5000)

    sendToRenderer('jsonl:state', sessionId, { state: 'working', summary: 'Thinking...' })
  }

  function notifyPermissionPrompt(sessionId) {
    const state = sessionStates.get(sessionId)
    if (!state) return

    const events = state.events
    if (events.length === 0) return

    const last = events[events.length - 1]
    if (last.type !== 'assistant') return

    const content = Array.isArray(last.message?.content) ? last.message.content : []
    const toolUses = content.filter((b) => b.type === 'tool_use')
    if (toolUses.length === 0) return

    const lastTool = toolUses[toolUses.length - 1]
    clearTimeout(state.staleTimer)

    const derived = { state: 'needs-input', summary: `Waiting for approval: ${lastTool.name}` }
    console.log(`[jsonlWatcher:${sessionId}] permission prompt — ${derived.summary}`)
    sendToRenderer('jsonl:state', sessionId, derived)
  }

  function notifyShellReturn(sessionId) {
    const state = sessionStates.get(sessionId)
    if (!state || !state.locked) return

    console.log(`[jsonlWatcher:${sessionId}] shell return — session ended`)
    sendToRenderer('jsonl:state', sessionId, { state: 'done', summary: 'Session ended' })
    sendToRenderer('jsonl:session-ended', sessionId)
    unlockSession(sessionId, state)
  }

  function stopWatching(sessionId) {
    const state = sessionStates.get(sessionId)
    if (!state) return
    clearTimeout(state.staleTimer)
    if (state.filePath) fileOwners.delete(state.filePath)
    sessionStates.delete(sessionId)

    // Stop global watcher when no sessions remain
    if (sessionStates.size === 0 && globalWatcher) {
      globalWatcher.close()
      globalWatcher = null
      fileOwners.clear()
    }
  }

  function stopAll() {
    for (const [, state] of sessionStates) {
      clearTimeout(state.staleTimer)
    }
    sessionStates.clear()
    fileOwners.clear()
    if (globalWatcher) {
      globalWatcher.close()
      globalWatcher = null
    }
  }

  /**
   * List recent sessions for a project directory.
   */
  function listRecentSessions(cwd) {
    const projectDir = getProjectDir(cwd)
    let files
    try {
      files = fs.readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const filePath = path.join(projectDir, f)
          const stat = fs.statSync(filePath)
          return { name: f, filePath, mtime: stat.mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 15)
    } catch {
      return []
    }

    const sessions = []
    const seenSessionIds = new Set()

    for (const file of files) {
      try {
        const content = fs.readFileSync(file.filePath, 'utf8')
        const lines = content.trim().split('\n')

        let sessionId = null
        let firstPrompt = ''
        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            if (!sessionId && event.sessionId) {
              sessionId = event.sessionId
            }
            if (!firstPrompt && event.type === 'user' && event.message?.content) {
              const content = event.message.content
              if (typeof content === 'string') {
                firstPrompt = content.slice(0, 100)
              } else if (Array.isArray(content)) {
                const textBlock = content.find((b) => b.type === 'text')
                if (textBlock) firstPrompt = textBlock.text.slice(0, 100)
              }
            }
            if (sessionId && firstPrompt) break
          } catch { /* skip bad lines */ }
        }

        if (!sessionId || seenSessionIds.has(sessionId)) continue
        seenSessionIds.add(sessionId)

        sessions.push({
          sessionId,
          filename: file.name,
          lastModified: file.mtime,
          preview: firstPrompt || '(no prompt)',
        })
      } catch { /* skip unreadable files */ }
    }

    return sessions.slice(0, 10)
  }

  return { snapshotFiles, getProjectDir, startWatching, stopWatching, notifyExit, notifyThinking, notifyPermissionPrompt, notifyShellReturn, listRecentSessions, stopAll }
}
