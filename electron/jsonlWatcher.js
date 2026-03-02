// JSONL Session Watcher — watches Claude Code's session JSONL files for state.
//
// Claude Code writes a JSONL file per session at:
//   ~/.claude/projects/<encoded-path>/<uuid>.jsonl
//
// The encoded path replaces slashes and underscores with dashes:
//   /Users/me/my_project → -Users-me-my-project
//
// Strategy: snapshot existing .jsonl files BEFORE spawning Claude,
// then watch for a NEW file that wasn't in the snapshot. That's the
// session's file. Only tail that one file — never switch.

import fs from 'fs'
import path from 'path'
import os from 'os'
import { watch } from 'chokidar'

// Event types that carry meaningful conversation state
const MEANINGFUL_TYPES = new Set(['user', 'assistant', 'system', 'result'])

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
    return { state: 'working', summary: 'Processing prompt...' }
  }

  return { state: 'idle', summary: '' }
}

function formatToolInput(toolUse) {
  const input = toolUse.input || {}
  switch (toolUse.name) {
    case 'Read': return input.file_path ? path.basename(input.file_path) : ''
    case 'Write':
    case 'Edit': return input.file_path ? path.basename(input.file_path) : ''
    case 'Bash': return (input.command || '').slice(0, 60)
    case 'Glob': return input.pattern || ''
    case 'Grep': return input.pattern || ''
    default: return ''
  }
}

function eventToLogEntry(event) {
  const timestamp = event.timestamp
    ? new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false })
    : ''

  if (event.type === 'user') {
    const content = event.message?.content
    if (typeof content === 'string') {
      return { timestamp, icon: '👤', label: 'User prompt', detail: content.slice(0, 80) }
    }
    const blocks = Array.isArray(content) ? content : []
    if (blocks.some((b) => b.type === 'tool_result')) {
      return { timestamp, icon: '✅', label: 'Tool result', detail: `${blocks.filter((b) => b.type === 'tool_result').length} result(s)` }
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
      }))
    }

    if (blocks.find((b) => b.type === 'thinking')) {
      return { timestamp, icon: '🤔', label: 'Thinking', detail: '' }
    }

    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
    if (text) {
      return { timestamp, icon: '💬', label: 'Response', detail: text.slice(0, 80) }
    }
  }

  if (event.type === 'system') {
    return { timestamp, icon: '⚙️', label: 'System', detail: '' }
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
  const watchers = new Map()

  function sendToRenderer(channel, ...args) {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }

  /**
   * Encode a directory path the way Claude Code does:
   * /Users/me/my_project → -Users-me-my-project
   */
  function encodeProjectPath(dirPath) {
    return dirPath.replace(/[/_]/g, '-')
  }

  function getProjectDir(cwd) {
    return path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(cwd))
  }

  /**
   * Snapshot all existing .jsonl filenames in the project dir.
   * Call this BEFORE spawning Claude so we can diff later.
   */
  function snapshotFiles(cwd) {
    const projectDir = getProjectDir(cwd)
    try {
      return new Set(
        fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))
      )
    } catch {
      return new Set()
    }
  }

  /**
   * Start watching for the session's JSONL file.
   *
   * Two modes:
   *  1. New session: pass existingFiles snapshot. Watcher waits for a NEW
   *     .jsonl file to appear and locks onto it.
   *  2. Resumed session: pass claudeSessionId. Watcher locks directly onto
   *     <claudeSessionId>.jsonl, skips to end, tails new content. Also reads
   *     the last few events to derive initial status.
   *
   * @param {string} sessionId - Our internal session ID
   * @param {string} cwd - Working directory
   * @param {object} opts
   * @param {Set<string>} [opts.existingFiles] - Snapshot from before spawn (new session)
   * @param {string} [opts.claudeSessionId] - Claude's session UUID (resumed session)
   */
  function startWatching(sessionId, cwd, opts = {}) {
    const projectDir = getProjectDir(cwd)
    const { existingFiles, claudeSessionId } = opts

    if (!fs.existsSync(projectDir)) {
      try { fs.mkdirSync(projectDir, { recursive: true }) } catch { /* */ }
    }

    const state = {
      events: [],
      bytesRead: 0,
      filePath: null,
      lastWriteTime: Date.now(),
      staleTimer: null,
      locked: false,
    }

    // ── Resumed session: lock onto known file immediately ──
    if (claudeSessionId) {
      const targetFile = path.join(projectDir, `${claudeSessionId}.jsonl`)
      console.log(`[jsonlWatcher:${sessionId}] RESUME mode — locking to ${claudeSessionId}.jsonl`)

      if (fs.existsSync(targetFile)) {
        state.filePath = targetFile
        state.locked = true

        // Read the last few events to derive initial status
        const initialEvents = readLastEvents(targetFile, 10)
        state.events = initialEvents

        // Skip to end — only tail new content going forward
        try { state.bytesRead = fs.statSync(targetFile).size } catch { /* */ }

        // Send initial state to renderer
        if (initialEvents.length > 0) {
          const derived = deriveState(initialEvents, Date.now())
          sendToRenderer('jsonl:state', sessionId, derived)
        }
      } else {
        console.warn(`[jsonlWatcher:${sessionId}] resume file not found, falling back to new-file detection`)
        // Fall through to watcher below
      }
    }

    console.log(`[jsonlWatcher:${sessionId}] watching ${projectDir}`)

    const watcher = watch(projectDir, {
      ignoreInitial: false,
      awaitWriteFinish: false,
      depth: 0,
    })

    // For new sessions: detect new file via snapshot diff
    watcher.on('add', (filePath) => {
      if (state.locked) return
      if (!filePath.endsWith('.jsonl')) return

      const basename = path.basename(filePath)
      if (existingFiles && existingFiles.has(basename)) return

      console.log(`[jsonlWatcher:${sessionId}] LOCKED to new session file: ${basename}`)
      state.filePath = filePath
      state.bytesRead = 0
      state.locked = true
      readNewLines(sessionId, state)
    })

    // Tail the locked file when it changes
    watcher.on('change', (filePath) => {
      if (!state.locked || filePath !== state.filePath) return

      state.lastWriteTime = Date.now()
      readNewLines(sessionId, state)

      clearTimeout(state.staleTimer)
      state.staleTimer = setTimeout(() => {
        const derived = deriveState(state.events, state.lastWriteTime)
        sendToRenderer('jsonl:state', sessionId, derived)
      }, 5000)
    })

    watchers.set(sessionId, { watcher, state })
  }

  /**
   * Read the last N events from a JSONL file (for initial status on resume).
   */
  function readLastEvents(filePath, count) {
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      const lines = content.trim().split('\n')
      const lastLines = lines.slice(-count)
      const events = []
      for (const line of lastLines) {
        try { events.push(JSON.parse(line)) } catch { /* */ }
      }
      return events
    } catch {
      return []
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
        }

        const derived = deriveState(state.events, state.lastWriteTime)
        sendToRenderer('jsonl:state', sessionId, derived)
      }
    })
  }

  function notifyExit(sessionId, exitCode) {
    const entry = watchers.get(sessionId)
    if (!entry) return

    const derived = exitCode === 0
      ? { state: 'done', summary: 'Session complete' }
      : { state: 'error', summary: `Exit code ${exitCode}` }

    sendToRenderer('jsonl:state', sessionId, derived)
  }

  /**
   * Called by ptyManager when a permission prompt is detected in the terminal.
   * Immediately transitions to needs-input without waiting for the stale timer.
   */
  /**
   * Called by ptyManager when a thinking spinner is detected in the terminal.
   * Overrides idle/stale state to working.
   */
  function notifyThinking(sessionId) {
    const entry = watchers.get(sessionId)
    if (!entry) return

    const { state } = entry

    // Reset the stale timer so it doesn't flip back to idle
    clearTimeout(state.staleTimer)
    state.staleTimer = setTimeout(() => {
      const derived = deriveState(state.events, state.lastWriteTime)
      sendToRenderer('jsonl:state', sessionId, derived)
    }, 5000)

    sendToRenderer('jsonl:state', sessionId, { state: 'working', summary: 'Thinking...' })
  }

  function notifyPermissionPrompt(sessionId) {
    const entry = watchers.get(sessionId)
    if (!entry) return

    const { state } = entry
    const events = state.events
    if (events.length === 0) return

    // Only flip if the last JSONL event has a pending tool_use (no tool_result yet)
    const last = events[events.length - 1]
    if (last.type !== 'assistant') return

    const content = Array.isArray(last.message?.content) ? last.message.content : []
    const toolUses = content.filter((b) => b.type === 'tool_use')
    if (toolUses.length === 0) return

    const lastTool = toolUses[toolUses.length - 1]

    // Clear the stale timer since we're setting state immediately
    clearTimeout(state.staleTimer)

    const derived = { state: 'needs-input', summary: `Waiting for approval: ${lastTool.name}` }
    console.log(`[jsonlWatcher:${sessionId}] permission prompt detected — ${derived.summary}`)
    sendToRenderer('jsonl:state', sessionId, derived)
  }

  function stopWatching(sessionId) {
    const entry = watchers.get(sessionId)
    if (!entry) return
    clearTimeout(entry.state.staleTimer)
    entry.watcher.close()
    watchers.delete(sessionId)
  }

  function stopAll() {
    for (const [, entry] of watchers) {
      clearTimeout(entry.state.staleTimer)
      entry.watcher.close()
    }
    watchers.clear()
  }

  /**
   * List recent sessions for a project directory.
   * Reads JSONL files to extract sessionId, last timestamp, and first user prompt.
   * Returns up to 10 most recent sessions, sorted by last modified.
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

        // Find sessionId from first event that has one
        let sessionId = null
        let firstPrompt = ''
        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            if (!sessionId && event.sessionId) {
              sessionId = event.sessionId
            }
            // Grab first user prompt as preview
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

  return { snapshotFiles, getProjectDir, startWatching, stopWatching, notifyExit, notifyThinking, notifyPermissionPrompt, listRecentSessions, stopAll }
}
