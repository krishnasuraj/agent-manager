// PTY Manager — spawns coding agents in real pseudoterminals via node-pty.
// Each session gets its own PTY process. Data flows:
//   PTY stdout → IPC → renderer (xterm.js)
//   renderer (keyboard) → IPC → PTY stdin
//
// Tool-specific patterns (startup, permission, thinking) come from toolConfigs.js.

import * as pty from 'node-pty'
import fs from 'fs'
import { execSync } from 'child_process'
import { getToolConfig } from './toolConfigs.js'

function getCleanEnv(toolConfig) {
  const env = { ...process.env }
  if (toolConfig?.envPrefixToScrub) {
    const prefix = toolConfig.envPrefixToScrub.toUpperCase()
    for (const key of Object.keys(env)) {
      if (key.toUpperCase().includes(prefix)) delete env[key]
    }
  }
  return env
}

function getUserShell() {
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return process.env.SHELL
  }
  for (const s of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(s)) return s
  }
  return '/bin/sh'
}

// Strip ANSI escape sequences from terminal output
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g, '')
}

// Patterns that indicate the shell prompt has returned (agent exited).
// Shared across all tools — these detect the user's shell, not the agent.
const SHELL_PROMPT_PATTERNS = [
  /\S+@\S+.*[$%#]\s*$/,
  /~[/\w]*\s*[$%❯#]\s*$/,
  /\w+[/\w]*\s+[$%❯]\s*$/,
  /^\s*\$\s*$/m,
  /^\s*%\s*$/m,
]

// How much PTY output to keep in the rolling buffer (bytes)
const PTY_BUFFER_SIZE = 4096

export function createPtyManager(getWindow) {
  // sessionId → { pty, cwd, toolId, toolConfig, outputBuffer, ... }
  const sessions = new Map()

  function sendToRenderer(channel, ...args) {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }

  /**
   * Check PTY output for permission prompts and thinking spinners.
   * Uses tool-specific patterns from toolConfig.
   */
  function checkPtyOutput(sessionId, rawData) {
    const session = sessions.get(sessionId)
    if (!session) return

    // Append to rolling buffer, trim to max size
    session.outputBuffer += rawData
    if (session.outputBuffer.length > PTY_BUFFER_SIZE) {
      session.outputBuffer = session.outputBuffer.slice(-PTY_BUFFER_SIZE)
    }

    // Only check the last ~1KB (the recent output area)
    const recentRaw = session.outputBuffer.slice(-1024)
    const recent = stripAnsi(recentRaw)
    const now = Date.now()
    const tc = session.toolConfig

    // Detect agent starting — look for tool-specific startup patterns
    if (!session.agentRunning) {
      if (tc.startupPatterns.some((p) => p.test(recent))) {
        session.agentRunning = true
        session.startupTime = now
        session.pendingShellReturn = null
        session.outputBuffer = ''  // clear so stale shell prompts don't trigger false exit
        console.log(`[ptyManager:${sessionId}] ${tc.displayName} detected as running`)
        // Only fire startup callback for tools that need it (Codex — JSONL
        // isn't created until seconds after the TUI appears). Claude's existing
        // JSONL watcher flow handles startup state fine.
        if (session.startupCallback && tc.startupCooldownMs) {
          session.startupCallback(sessionId)
        }
      }
      return
    }

    // Startup cooldown — don't check shell return too soon after agent starts.
    // Full-screen TUI apps (Codex/Ratatui) take a moment to enter alternate
    // screen, and the shell prompt is still visible in the buffer during that time.
    const cooldown = tc.startupCooldownMs || 0
    if (cooldown && session.startupTime && (now - session.startupTime < cooldown)) {
      return
    }

    // Check for permission prompts FIRST — must take priority over thinking
    for (const pattern of tc.permissionPatterns) {
      if (pattern.test(recent)) {
        if (now - session.lastPermissionFired < 2000) return
        session.lastPermissionFired = now
        console.log(`[ptyManager:${sessionId}] permission prompt detected via PTY output`)
        session.outputBuffer = ''
        if (session.permissionCallback) {
          session.permissionCallback(sessionId)
        }
        return
      }
    }

    // Check for thinking/working indicators
    if (tc.thinkingPatterns.length > 0 && tc.thinkingPatterns.some((p) => p.test(recent))) {
      if (now - session.lastThinkingFired < 3000) return
      session.lastThinkingFired = now
      if (session.thinkingCallback) {
        session.thinkingCallback(sessionId)
      }
      return
    }

    // Detect shell prompt returning (agent exited).
    // Require TWO consecutive matches 500ms apart to avoid false positives.
    const promptMatch = SHELL_PROMPT_PATTERNS.some((p) => p.test(recent))
    if (session.agentRunning && promptMatch) {
      if (!session.pendingShellReturn) {
        session.pendingShellReturn = now
      } else if (now - session.pendingShellReturn > 500) {
        if (now - session.lastShellReturnFired < 3000) return
        session.lastShellReturnFired = now
        session.agentRunning = false
        session.pendingShellReturn = null
        session.outputBuffer = ''
        console.log(`[ptyManager:${sessionId}] shell prompt returned — ${tc.displayName} exited`)
        if (session.shellReturnCallback) {
          session.shellReturnCallback(sessionId)
        }
      }
    } else {
      session.pendingShellReturn = null
    }
  }

  /**
   * Spawn a coding agent session in a real PTY.
   * @param {string} sessionId - Unique session identifier
   * @param {object} opts
   * @param {string} opts.cwd - Working directory for the session
   * @param {string} [opts.toolId] - 'claude' or 'codex' (defaults to 'claude')
   * @param {string} [opts.initialPrompt] - Optional prompt to type after spawn
   * @param {boolean} [opts.autoLaunch] - Auto-type the tool binary name
   */
  function spawn(sessionId, { cwd, toolId = 'claude', initialPrompt, autoLaunch = false }) {
    if (sessions.has(sessionId)) {
      console.warn(`[ptyManager] session ${sessionId} already exists`)
      return
    }

    const toolConfig = getToolConfig(toolId)
    const env = getCleanEnv(toolConfig)
    const shell = getUserShell()

    console.log(`[ptyManager:${sessionId}] spawning ${toolConfig.displayName} in ${cwd}`)

    const ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env,
    })

    sessions.set(sessionId, {
      pty: ptyProcess,
      cwd,
      toolId,
      toolConfig,
      outputBuffer: '',
      lastPermissionFired: 0,
      lastThinkingFired: 0,
      lastShellReturnFired: 0,
      pendingShellReturn: null,
      agentRunning: false,
      startupTime: 0,
      permissionCallback: null,
      thinkingCallback: null,
      shellReturnCallback: null,
      startupCallback: null,
    })

    // Forward PTY data to renderer + check for prompts/spinners
    ptyProcess.onData((data) => {
      sendToRenderer('pty:data', sessionId, data)
      checkPtyOutput(sessionId, data)
    })

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[ptyManager:${sessionId}] PTY exited code=${exitCode} signal=${signal}`)
      sessions.delete(sessionId)
      sendToRenderer('pty:exit', sessionId, { exitCode, signal })
    })

    // Optionally auto-launch the agent in the PTY
    if (autoLaunch) {
      setTimeout(() => {
        ptyProcess.write(`${toolConfig.binary}\r`)

        if (initialPrompt) {
          setTimeout(() => {
            ptyProcess.write(initialPrompt)
            ptyProcess.write('\r')
          }, 2000)
        }
      }, 500)
    }

    return ptyProcess
  }

  function write(sessionId, data) {
    const session = sessions.get(sessionId)
    if (!session) return
    session.pty.write(data)
  }

  function resize(sessionId, cols, rows) {
    const session = sessions.get(sessionId)
    if (!session) return
    session.pty.resize(cols, rows)
  }

  function kill(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) return
    session.pty.kill()
    sessions.delete(sessionId)
  }

  function killAll() {
    for (const [id, session] of sessions) {
      console.log(`[ptyManager] killing session ${id}`)
      session.pty.kill()
    }
    sessions.clear()
  }

  function has(sessionId) {
    return sessions.has(sessionId)
  }

  function getCwd(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) return null
    try {
      const pid = session.pty.pid
      const output = execSync(`lsof -a -d cwd -Fn -p ${pid}`, { encoding: 'utf8', timeout: 2000 })
      const match = output.match(/\nn(.+)/)
      return match ? match[1] : session.cwd
    } catch {
      return session.cwd
    }
  }

  function onPermissionPrompt(sessionId, callback) {
    const session = sessions.get(sessionId)
    if (session) session.permissionCallback = callback
  }

  function onThinking(sessionId, callback) {
    const session = sessions.get(sessionId)
    if (session) session.thinkingCallback = callback
  }

  function onStartup(sessionId, callback) {
    const session = sessions.get(sessionId)
    if (session) session.startupCallback = callback
  }

  function onShellReturn(sessionId, callback) {
    const session = sessions.get(sessionId)
    if (session) session.shellReturnCallback = callback
  }

  function getPids() {
    const pids = []
    for (const [, session] of sessions) {
      if (session.pty?.pid) pids.push(session.pty.pid)
    }
    return pids
  }

  return { spawn, write, resize, kill, killAll, has, getCwd, getPids, onStartup, onPermissionPrompt, onThinking, onShellReturn }
}
