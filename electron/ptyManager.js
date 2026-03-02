// PTY Manager — spawns Claude Code in a real pseudoterminal via node-pty.
// Each session gets its own PTY process. Data flows:
//   PTY stdout → IPC → renderer (xterm.js)
//   renderer (keyboard) → IPC → PTY stdin

import * as pty from 'node-pty'
import fs from 'fs'
import os from 'os'
import { execSync } from 'child_process'

function getCleanEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().includes('CLAUDE')) delete env[key]
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

function findClaudeBinary() {
  const candidates = [
    `${os.homedir()}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch { /* ignore */ }
  }
  try {
    const resolved = execSync('which claude', { encoding: 'utf8', env: getCleanEnv() }).trim()
    if (resolved) return resolved
  } catch { /* ignore */ }
  return 'claude'
}

// Strip ANSI escape sequences from terminal output
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g, '')
}

// Patterns that indicate Claude Code is showing a permission/approval prompt.
// These appear in the terminal when Claude wants to run a tool and needs user consent.
const PERMISSION_PATTERNS = [
  /Allow\s+Deny/i,                         // "Allow  Deny" buttons side by side
  /❯\s*(Allow|Yes)/,                        // Arrow selection on Allow/Yes
  /Allow once/i,
  /Allow always/i,
  /Yes.*don't ask again/i,                  // "Yes, and don't ask again" option
]

// How much PTY output to keep in the rolling buffer (bytes)
const PTY_BUFFER_SIZE = 4096

export function createPtyManager(getWindow) {
  // sessionId → { pty, cwd, outputBuffer, permissionCallback }
  const sessions = new Map()

  function sendToRenderer(channel, ...args) {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }

  /**
   * Check PTY output for permission prompts and thinking spinners.
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

    // Check for thinking spinners — all use "* Word..." or "* Word…" format
    if (/\*\s+[A-Z][a-z]+[.…]/.test(recent)) {
      if (now - session.lastThinkingFired < 3000) return
      session.lastThinkingFired = now
      if (session.thinkingCallback) {
        session.thinkingCallback(sessionId)
      }
      return
    }

    // Check for permission prompts
    for (const pattern of PERMISSION_PATTERNS) {
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

  }

  /**
   * Spawn a Claude Code session in a real PTY.
   * @param {string} sessionId - Unique session identifier
   * @param {object} opts
   * @param {string} opts.cwd - Working directory for the session
   * @param {string} [opts.claudeSessionId] - Resume an existing Claude session
   * @param {string} [opts.initialPrompt] - Optional prompt to type after spawn
   */
  function spawn(sessionId, { cwd, claudeSessionId, initialPrompt }) {
    if (sessions.has(sessionId)) {
      console.warn(`[ptyManager] session ${sessionId} already exists`)
      return
    }

    const claudeBin = findClaudeBinary()
    const env = getCleanEnv()
    const shell = getUserShell()

    console.log(`[ptyManager:${sessionId}] spawning claude at ${claudeBin} in ${cwd}`)

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
      outputBuffer: '',
      lastPermissionFired: 0,
      lastThinkingFired: 0,
      permissionCallback: null,
      thinkingCallback: null,
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

    // Launch claude in the PTY after a brief delay for shell init
    setTimeout(() => {
      let cmd = claudeBin
      if (claudeSessionId) {
        cmd += ` --resume "${claudeSessionId}"`
      }
      ptyProcess.write(`${cmd}\r`)

      // If there's an initial prompt, type it after Claude starts
      if (initialPrompt) {
        setTimeout(() => {
          ptyProcess.write(initialPrompt)
          ptyProcess.write('\r')
        }, 2000)
      }
    }, 500)

    return ptyProcess
  }

  /**
   * Write data to a session's PTY (keyboard input from renderer).
   */
  function write(sessionId, data) {
    const session = sessions.get(sessionId)
    if (!session) return
    session.pty.write(data)
  }

  /**
   * Resize a session's PTY.
   */
  function resize(sessionId, cols, rows) {
    const session = sessions.get(sessionId)
    if (!session) return
    session.pty.resize(cols, rows)
  }

  /**
   * Kill a session's PTY process.
   */
  function kill(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) return
    session.pty.kill()
    sessions.delete(sessionId)
  }

  /**
   * Kill all PTY processes (called on app quit).
   */
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

  /**
   * Register a callback that fires when a permission prompt is detected
   * in the PTY output for a given session.
   */
  function onPermissionPrompt(sessionId, callback) {
    const session = sessions.get(sessionId)
    if (session) {
      session.permissionCallback = callback
    }
  }

  /**
   * Register a callback that fires when a thinking spinner is detected.
   */
  function onThinking(sessionId, callback) {
    const session = sessions.get(sessionId)
    if (session) {
      session.thinkingCallback = callback
    }
  }

  return { spawn, write, resize, kill, killAll, has, onPermissionPrompt, onThinking }
}
