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

  function getProjectsRoot() {
    return path.join(os.homedir(), '.claude', 'projects')
  }

  /**
   * Snapshot all existing .jsonl files across ALL project dirs.
   * Returns a Set of full paths. Call BEFORE spawning so we can diff later.
   */
  /**
   * Snapshot all existing .jsonl files across ALL project dirs.
   * Returns a Map of full path → file size in bytes.
   * Call BEFORE spawning so we can diff later.
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
   * Start watching for any new JSONL file across all project dirs.
   * When the user starts Claude in any directory, the watcher picks it up.
   *
   * @param {string} sessionId - Our internal session ID
   * @param {object} opts
   * @param {Set<string>} [opts.existingFiles] - Snapshot from before spawn (full paths)
   */
  function startWatching(sessionId, opts = {}) {
    const projectsRoot = getProjectsRoot()
    const { existingFiles } = opts

    if (!fs.existsSync(projectsRoot)) {
      try { fs.mkdirSync(projectsRoot, { recursive: true }) } catch { /* */ }
    }

    const state = {
      events: [],
      bytesRead: 0,
      filePath: null,
      lastWriteTime: Date.now(),
      staleTimer: null,
      locked: false,
      knownFiles: existingFiles || new Set(),
    }

    console.log(`[jsonlWatcher:${sessionId}] watching ${projectsRoot} (all projects)`)

    const watcher = watch(projectsRoot, {
      ignoreInitial: false,
      awaitWriteFinish: false,
      depth: 1,
    })

    // Track new files we haven't seen before, but don't lock yet
    watcher.on('add', (filePath) => {
      if (!filePath.endsWith('.jsonl')) return
      if (!state.knownFiles.has(filePath)) {
        // Record it with size 0 so the change handler can detect growth
        console.log(`[jsonlWatcher:${sessionId}] new file appeared: ${path.basename(filePath)}`)
        state.knownFiles.set(filePath, 0)
      }
    })

    // Lock onto whichever file is actively being written to
    watcher.on('change', (filePath) => {
      if (!filePath.endsWith('.jsonl')) return

      // If unlocked, lock onto the first file that's growing
      if (!state.locked) {
        const snapshotSize = state.knownFiles.get(filePath)
        if (snapshotSize === undefined) return

        let currentSize
        try { currentSize = fs.statSync(filePath).size } catch { return }
        if (currentSize <= snapshotSize) return

        const isResume = snapshotSize > 0
        console.log(`[jsonlWatcher:${sessionId}] LOCKED to ${isResume ? 'resumed' : 'new'} session file: ${path.basename(filePath)} (${snapshotSize} → ${currentSize})`)
        state.filePath = filePath
        state.bytesRead = isResume ? 0 : snapshotSize  // read full history for resumed, only new for fresh
        state.locked = true
        sendToRenderer('jsonl:session-started', sessionId)
        readNewLines(sessionId, state)
        return
      }

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

          // Detect Claude session end — the "result" event means Claude exited
          if (event.type === 'result') {
            console.log(`[jsonlWatcher:${sessionId}] result event detected — ending session via JSONL`)
            sendToRenderer('jsonl:state', sessionId, { state: 'done', summary: 'Session complete' })
            sendToRenderer('jsonl:session-ended', sessionId)

            // Unlock watcher so it can detect the next Claude session.
            // Re-snapshot so only truly new files get picked up.
            state.locked = false
            state.events = []
            clearTimeout(state.staleTimer)
            state.knownFiles = snapshotFiles()
            return
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

  /**
   * Called by ptyManager when the shell prompt returns (Claude exited).
   * Immediately ends the session regardless of whether a result event was written.
   */
  function notifyShellReturn(sessionId) {
    const entry = watchers.get(sessionId)
    if (!entry) return

    const { state } = entry
    if (!state.locked) return

    console.log(`[jsonlWatcher:${sessionId}] shell return detected — ending session`)
    sendToRenderer('jsonl:state', sessionId, { state: 'done', summary: 'Session ended' })
    sendToRenderer('jsonl:session-ended', sessionId)

    state.locked = false
    state.events = []
    clearTimeout(state.staleTimer)
    state.knownFiles = snapshotFiles()
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

  return { snapshotFiles, getProjectDir, startWatching, stopWatching, notifyExit, notifyThinking, notifyPermissionPrompt, notifyShellReturn, listRecentSessions, stopAll }
}
