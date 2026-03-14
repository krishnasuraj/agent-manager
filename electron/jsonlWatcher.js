// JSONL Session Watcher — watches coding agent session JSONL files for state.
//
// Supports multiple tools (Claude Code, Codex CLI) via toolConfigs.js.
// Each tool has its own session file location, schema, and state derivation.
//
// Architecture: one chokidar watcher per tool root directory. Each file-change
// event fires a single callback that routes to the owning session. This eliminates
// race conditions from multiple independent watchers.

import fs from 'fs'
import path from 'path'
import { watch } from 'chokidar'
import { getToolConfig, getAllToolConfigs } from './toolConfigs.js'

// Max events kept in memory per session — only the tail matters for state derivation
const MAX_EVENTS = 50

// ─── Exported module ─────────────────────────────────────────────

export function createJsonlWatcher(getWindow) {
  // toolId → chokidar watcher instance
  const watchers = new Map()

  // sessionId → per-session state
  const sessionStates = new Map()

  // filePath → sessionId: which session owns each JSONL file
  const fileOwners = new Map()

  // Optional callback for state changes (used by main process for notifications)
  let stateChangeCallback = null

  function onStateChange(cb) {
    stateChangeCallback = cb
  }

  function sendToRenderer(channel, ...args) {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }

  function emitState(sessionId, state) {
    sendToRenderer('jsonl:state', sessionId, state)
    if (stateChangeCallback) stateChangeCallback(sessionId, state)
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

    // Try each tool's routing logic to find the matching session
    for (const tc of getAllToolConfigs()) {
      const sessionId = tc.matchFileToSession(filePath, sessionStates)
      if (sessionId) {
        const state = sessionStates.get(sessionId)
        if (state && tryClaimFile(sessionId, state, filePath)) return
      }
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

    const tc = getToolConfig(state.toolId)
    // Stale timer: re-read file and re-derive state after 5s of no chokidar events.
    // Catches events written between reads (e.g. task_complete right after agent_message).
    // For Claude: also detects permission prompts (tool_use with no result).
    // For Codex: also detects approval prompts (function_call with no output).
    clearTimeout(state.staleTimer)
    state.staleTimer = setTimeout(() => {
      readNewLines(sessionId, state)
      const derived = tc.deriveState(state.events, state.lastWriteTime)
      emitState(sessionId, derived)
    }, 5000)
  }

  /**
   * Ensure a chokidar watcher exists for the given tool.
   */
  function ensureWatcher(toolId) {
    if (watchers.has(toolId)) return

    const tc = getToolConfig(toolId)
    const root = tc.sessionRoot

    if (!fs.existsSync(root)) {
      try { fs.mkdirSync(root, { recursive: true }) } catch { /* */ }
    }

    console.log(`[jsonlWatcher] starting watcher for ${tc.displayName} on ${root}`)

    const watcher = watch(root, {
      ignoreInitial: false,
      awaitWriteFinish: false,
      depth: tc.watchDepth,
    })

    watcher.on('add', (filePath) => {
      if (!filePath.endsWith('.jsonl')) return
      // Register new files with their current size so old files (from the
      // initial scan) don't get claimed. Only files that grow PAST their
      // registered size can be claimed by tryClaimFile.
      let fileSize = 0
      try { fileSize = fs.statSync(filePath).size } catch { /* */ }
      for (const [, s] of sessionStates) {
        if (s.toolId !== toolId) continue
        if (!s.knownFiles.has(filePath)) {
          s.knownFiles.set(filePath, fileSize)
        }
      }
    })

    watcher.on('change', (filePath) => {
      if (!filePath.endsWith('.jsonl')) return
      routeFileChange(filePath)
    })

    watchers.set(toolId, watcher)
  }

  /**
   * Start watching for JSONL events for a session.
   *
   * @param {string} sessionId
   * @param {object} opts
   * @param {string} opts.toolId - 'claude' or 'codex'
   * @param {Map<string,number>} [opts.existingFiles] - Snapshot from before spawn
   * @param {string} [opts.cwd] - Working directory of this session's shell
   */
  function startWatching(sessionId, opts = {}) {
    const toolId = opts.toolId || 'claude'
    const { existingFiles, cwd } = opts

    const state = {
      toolId,
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
    console.log(`[jsonlWatcher:${sessionId}] registered (tool: ${toolId}, cwd: ${state.cwd})`)

    ensureWatcher(toolId)
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
      const tc = getToolConfig(state.toolId)

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
          const entry = tc.eventToLogEntry(event)
          if (entry) {
            const entries = Array.isArray(entry) ? entry : [entry]
            for (const e of entries) {
              sendToRenderer('jsonl:event', sessionId, e)
            }
          }

          // Detect session end
          if (tc.isSessionEndEvent(event)) {
            console.log(`[jsonlWatcher:${sessionId}] session end event — session ended`)
            emitState(sessionId, { state: 'done', summary: 'Session complete' })
            sendToRenderer('jsonl:session-ended', sessionId)
            unlockSession(sessionId, state)
            return
          }
        }

        const derived = tc.deriveState(state.events, state.lastWriteTime)
        emitState(sessionId, derived)
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
    // Re-snapshot using the tool-specific logic
    const tc = getToolConfig(state.toolId)
    tc.resnapshotForSession(state)
  }

  function notifyStartup(sessionId) {
    const state = sessionStates.get(sessionId)
    if (!state) return
    // Agent detected in PTY — activate the sidebar before JSONL locks.
    // State is idle (waiting for user prompt), not working.
    emitState(sessionId, { state: 'idle', summary: 'Waiting for prompt' })
    sendToRenderer('jsonl:session-started', sessionId)
  }

  function notifyExit(sessionId, exitCode) {
    const state = sessionStates.get(sessionId)
    if (!state) return
    const derived = exitCode === 0
      ? { state: 'done', summary: 'Session complete' }
      : { state: 'error', summary: `Exit code ${exitCode}` }
    emitState(sessionId, derived)
  }

  function notifyThinking(sessionId) {
    const state = sessionStates.get(sessionId)
    if (!state) return

    clearTimeout(state.staleTimer)
    state.staleTimer = setTimeout(() => {
      const tc = getToolConfig(state.toolId)
      const derived = tc.deriveState(state.events, state.lastWriteTime)
      emitState(sessionId, derived)
    }, 5000)

    emitState(sessionId, { state: 'working', summary: 'Thinking...' })
  }

  function notifyPermissionPrompt(sessionId) {
    const state = sessionStates.get(sessionId)
    if (!state) return

    clearTimeout(state.staleTimer)

    // For Codex, we detect permissions via PTY only (no JSONL event for it).
    // Just fire the needs-input state directly.
    const tc = getToolConfig(state.toolId)
    if (tc.id === 'codex') {
      const derived = { state: 'needs-input', summary: 'Waiting for approval' }
      console.log(`[jsonlWatcher:${sessionId}] permission prompt (PTY) — ${derived.summary}`)
      emitState(sessionId, derived)
      return
    }

    // Claude: try to extract the tool name from the last JSONL event
    const events = state.events
    if (events.length === 0) return

    const last = events[events.length - 1]
    if (last.type !== 'assistant') return

    const content = Array.isArray(last.message?.content) ? last.message.content : []
    const toolUses = content.filter((b) => b.type === 'tool_use')
    if (toolUses.length === 0) return

    const lastTool = toolUses[toolUses.length - 1]
    const derived = { state: 'needs-input', summary: `Waiting for approval: ${lastTool.name}` }
    console.log(`[jsonlWatcher:${sessionId}] permission prompt — ${derived.summary}`)
    emitState(sessionId, derived)
  }

  function notifyShellReturn(sessionId) {
    const state = sessionStates.get(sessionId)
    if (!state || !state.locked) return

    console.log(`[jsonlWatcher:${sessionId}] shell return — session ended`)
    emitState(sessionId, { state: 'done', summary: 'Session ended' })
    sendToRenderer('jsonl:session-ended', sessionId)
    unlockSession(sessionId, state)
  }

  /**
   * Snapshot files for a specific tool. Called before spawning a session.
   */
  function snapshotFiles(toolId = 'claude') {
    const tc = getToolConfig(toolId)
    return tc.snapshotFiles()
  }

  function stopWatching(sessionId) {
    const state = sessionStates.get(sessionId)
    if (!state) return
    clearTimeout(state.staleTimer)
    if (state.filePath) fileOwners.delete(state.filePath)
    sessionStates.delete(sessionId)

    // Stop watchers for tools that have no remaining sessions
    for (const [toolId, watcher] of watchers) {
      const hasSession = [...sessionStates.values()].some(s => s.toolId === toolId)
      if (!hasSession) {
        watcher.close()
        watchers.delete(toolId)
      }
    }

    if (sessionStates.size === 0) {
      fileOwners.clear()
    }
  }

  function stopAll() {
    for (const [, state] of sessionStates) {
      clearTimeout(state.staleTimer)
    }
    sessionStates.clear()
    fileOwners.clear()
    for (const [, watcher] of watchers) {
      watcher.close()
    }
    watchers.clear()
  }

  return { snapshotFiles, startWatching, stopWatching, notifyStartup, notifyExit, notifyThinking, notifyPermissionPrompt, notifyShellReturn, stopAll, onStateChange }
}
