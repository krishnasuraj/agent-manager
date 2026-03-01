// Claude session manager. Spawns `claude -p` with stream-json per task,
// parses NDJSON events from stdout, maps events to task status, and
// forwards structured events to the renderer via IPC.
//
// Stream-json format from `claude -p`:
//   {"type":"assistant","message":{"role":"assistant","content":[...],...}}
//   {"type":"user","message":{"role":"user","content":[{"type":"tool_result",...}]}}
//   {"type":"result","subtype":"success",...,"session_id":"...","permission_denials":[...]}
// Each line is a complete message, NOT granular streaming deltas.
//
// When AskUserQuestion is denied (--dangerously-skip-permissions), the process
// exits with a "result" event containing permission_denials. To continue, we
// spawn a new `claude -p --resume <sessionId>` with the user's answer.

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import { execSync } from 'child_process'
import { createWorktree } from './worktree.js'

function getUserShell() {
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return process.env.SHELL
  }
  try {
    const username = os.userInfo().username
    const output = execSync(`dscl . -read /Users/${username} UserShell`, { encoding: 'utf8' })
    const shell = output.split(':').pop().trim()
    if (fs.existsSync(shell)) return shell
  } catch {
    // ignore
  }
  for (const s of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(s)) return s
  }
  return '/bin/sh'
}

function getCleanEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().includes('CLAUDE')) delete env[key]
  }
  return env
}

export function createClaudeManager(taskStore, getWindow) {
  // taskId -> { process, sessionId }
  // process is null when the claude -p process has exited but session can be resumed
  const sessions = new Map()

  function sendEvent(taskId, event) {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(`session:event:${taskId}`, event)
    }
  }

  function findClaudeBinary() {
    // Common install locations
    const candidates = [
      `${process.env.HOME || ''}/.local/bin/claude`,
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ]
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p
      } catch { /* ignore */ }
    }
    // Fallback: try to resolve via login shell
    try {
      const resolved = execSync('which claude', { encoding: 'utf8', env: getCleanEnv() }).trim()
      if (resolved) return resolved
    } catch { /* ignore */ }
    return 'claude' // hope it's on PATH
  }

  function spawnClaude(taskId, { cwd, prompt, resumeSessionId }) {
    const claudeBin = findClaudeBinary()

    let cmd = `"${claudeBin}" -p --output-format stream-json --input-format stream-json --verbose --dangerously-skip-permissions`
    if (resumeSessionId) {
      cmd += ` --resume "${resumeSessionId}"`
    }

    const env = getCleanEnv()

    // Spawn through /bin/sh (not login shell) for proper pipe handling
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    console.log(`[claudeManager:${taskId}] spawned pid=${child.pid}`)

    // If there's an initial prompt, send it via stdin after a short delay
    // to let claude initialize
    if (prompt) {
      setTimeout(() => {
        const msg = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: prompt },
          session_id: 'default',
          parent_tool_use_id: null,
        }) + '\n'
        console.log(`[claudeManager:${taskId}] sending initial prompt via stdin`)
        child.stdin.write(msg)
      }, 500)
    }

    let stdoutBuffer = ''

    child.stdout.on('data', (chunk) => {
      const raw = chunk.toString()
      process.stdout.write(raw)
      stdoutBuffer += raw
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop()

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed)
          handleEvent(taskId, event)
        } catch (err) {
          console.error('[claudeManager] JSON parse error:', err.message, 'line:', trimmed.slice(0, 200))
        }
      }
    })

    child.stderr.on('data', (chunk) => {
      console.error(`[claudeManager:${taskId}:stderr]`, chunk.toString())
    })

    child.on('error', (err) => {
      console.error(`[claudeManager:${taskId}] spawn error:`, err.message)
      taskStore.update(taskId, { status: 'completed', error: err.message })
      sendEvent(taskId, { type: 'error', error: err.message })
      sessions.delete(taskId)
    })

    child.on('exit', (code) => {
      console.log(`[claudeManager:${taskId}] process exited with code ${code}`)
      const session = sessions.get(taskId)
      if (session) {
        session.process = null // Process exited but session entry stays for resume
      }
      // Don't set completed here — handleEvent for "result" already handles status
      // Only set completed if we didn't get a result event (unexpected exit)
      const task = taskStore.get(taskId)
      if (task && task.status === 'in-progress') {
        if (code !== 0) {
          taskStore.update(taskId, { status: 'completed', error: `Process exited with code ${code}` })
        }
        // code 0 without result event: process exited normally, wait for result event
        // (it may have already been processed)
      }
    })

    return child
  }

  function startSession(taskId) {
    const task = taskStore.get(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    if (sessions.has(taskId) && sessions.get(taskId).process) return

    // Create worktree
    let worktreePath
    try {
      worktreePath = createWorktree(task)
    } catch (err) {
      console.error('[claudeManager] worktree creation failed:', err.message)
      worktreePath = process.cwd()
    }
    taskStore.update(taskId, { worktreePath })

    const cwd = fs.existsSync(worktreePath) ? worktreePath : process.cwd()

    // Don't spawn yet — wait for sendMessage with the initial prompt
    sessions.set(taskId, { process: null, sessionId: null, cwd })
  }

  function handleEvent(taskId, event) {
    const task = taskStore.get(taskId)
    if (!task) return

    if (event.type === 'assistant') {
      const msg = event.message
      if (!msg) return

      taskStore.update(taskId, { status: 'in-progress' })

      const content = msg.content || []
      const textParts = []
      const toolCalls = []

      for (const block of content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, input: block.input })
        }
      }

      const assembled = {
        role: 'assistant',
        content: textParts.join(''),
        toolCalls,
        timestamp: Date.now(),
        model: msg.model,
        usage: msg.usage,
      }

      const messages = [...(task.messages || []), assembled]
      const updates = { messages }

      if (msg.usage) {
        const current = task.tokenUsage || { input: 0, output: 0 }
        updates.tokenUsage = {
          input: current.input + (msg.usage.input_tokens || 0),
          output: current.output + (msg.usage.output_tokens || 0),
        }
      }

      // Determine status — AskUserQuestion detected here means it was called
      // but hasn't been denied yet (it will be denied in the result event)
      if (toolCalls.length > 0) {
        updates.status = 'in-progress'
      } else {
        updates.status = 'idle'
      }

      taskStore.update(taskId, updates)
      sendEvent(taskId, { type: 'assistant_message', message: assembled })

    } else if (event.type === 'user') {
      const msg = event.message
      if (!msg) return

      const content = msg.content || []
      const toolResults = []
      for (const block of content) {
        if (block.type === 'tool_result') {
          toolResults.push({ toolUseId: block.tool_use_id, content: block.content, isError: block.is_error })
        }
      }

      if (toolResults.length > 0) {
        const resultMsg = { role: 'tool_result', toolResults, timestamp: Date.now() }
        const messages = [...(task.messages || []), resultMsg]
        taskStore.update(taskId, { messages, status: 'in-progress' })
        sendEvent(taskId, { type: 'tool_result', results: toolResults })
      }

    } else if (event.type === 'result') {
      // Save session ID for resume
      const session = sessions.get(taskId)
      if (session && event.session_id) {
        session.sessionId = event.session_id
      }

      // Check for AskUserQuestion permission denial
      const denials = event.permission_denials || []
      const askDenial = denials.find((d) => d.tool_name === 'AskUserQuestion')

      if (askDenial) {
        const questions = askDenial.tool_input?.questions || []
        taskStore.update(taskId, { status: 'input-required' })
        sendEvent(taskId, {
          type: 'ask_user_question',
          questions,
          toolUseId: askDenial.tool_use_id,
        })
      } else {
        taskStore.update(taskId, { status: 'completed' })
        sendEvent(taskId, { type: 'session_end', cost: event.total_cost_usd })
      }

      // Update final usage
      if (event.usage) {
        taskStore.update(taskId, {
          tokenUsage: {
            input: event.usage.input_tokens || 0,
            output: event.usage.output_tokens || 0,
          },
        })
      }

    } else if (event.type === 'error') {
      taskStore.update(taskId, { error: event.error?.message || 'Unknown error' })
      sendEvent(taskId, { type: 'error', error: event.error?.message })
    }
  }

  function sendMessage(taskId, text) {
    const session = sessions.get(taskId)
    if (!session) throw new Error(`No active session for task ${taskId}`)

    // Append user message to task store
    const task = taskStore.get(taskId)
    if (task) {
      const messages = [...(task.messages || [])]
      messages.push({ role: 'user', content: text, timestamp: Date.now() })
      taskStore.update(taskId, { messages, status: 'in-progress' })
    }

    if (session.process && !session.process.killed) {
      // Process is still running — send via stdin (stream-json input)
      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: text },
        session_id: session.sessionId || 'default',
        parent_tool_use_id: null,
      }) + '\n'
      console.log(`[claudeManager:${taskId}] sending stdin:`, msg.trim())
      session.process.stdin.write(msg)
    } else {
      // Process has exited — spawn a new one, resuming if we have a session ID
      console.log(`[claudeManager:${taskId}] process not running, spawning new (resume=${session.sessionId || 'none'})`)
      const child = spawnClaude(taskId, {
        cwd: session.cwd,
        prompt: text,
        resumeSessionId: session.sessionId,
      })
      session.process = child
    }
  }

  function abort(taskId) {
    const session = sessions.get(taskId)
    if (!session?.process) return
    session.process.kill('SIGINT')
  }

  function stopSession(taskId) {
    const session = sessions.get(taskId)
    if (!session) return false
    if (session.process) {
      session.process.kill('SIGTERM')
    }
    sessions.delete(taskId)
    return true
  }

  function stopAll() {
    for (const [taskId, session] of sessions) {
      if (session.process && !session.process.killed) {
        console.log(`[claudeManager] killing session ${taskId}`)
        session.process.kill('SIGTERM')
      }
    }
    sessions.clear()
  }

  function isRunning(taskId) {
    const session = sessions.get(taskId)
    return session?.process != null && !session.process.killed
  }

  return { startSession, stopSession, stopAll, sendMessage, abort, isRunning }
}
