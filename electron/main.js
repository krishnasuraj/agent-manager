import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import { createPtyManager } from './ptyManager.js'
import { createJsonlWatcher } from './jsonlWatcher.js'
import { createWorktreeManager } from './worktreeManager.js'

// Scrub Claude env vars so child processes don't inherit nesting detection
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().includes('CLAUDE')) {
    delete process.env[key]
  }
}

// Parse --test-sessions=N from CLI args
const testSessionsArg = process.argv.find((a) => a.startsWith('--test-sessions='))
const testSessionCount = testSessionsArg ? parseInt(testSessionsArg.split('=')[1], 10) || 0 : 0

let mainWindow = null

function getWindow() {
  return mainWindow
}

const ptyManager = createPtyManager(getWindow)
const jsonlWatcher = createJsonlWatcher(getWindow)
const worktreeManager = createWorktreeManager(process.cwd())

// ─── IPC handlers (registered once, outside createWindow) ───────────

// PTY input from renderer
ipcMain.on('pty:write', (_, sessionId, data) => {
  ptyManager.write(sessionId, data)
})

ipcMain.on('pty:resize', (_, sessionId, cols, rows) => {
  ptyManager.resize(sessionId, cols, rows)
})

// Test config
ipcMain.handle('app:getTestConfig', () => {
  const testCwds = []
  const testBranches = []
  for (let i = 0; i < testSessionCount; i++) {
    const branch = `test-${i + 1}`
    const { worktreePath } = worktreeManager.create(branch)
    testCwds.push(worktreePath)
    testBranches.push(branch)
  }
  return { testSessions: testSessionCount, testCwds, testBranches }
})

// Worktree operations
ipcMain.handle('worktree:create', (_, branch) => {
  const { worktreePath, existing } = worktreeManager.create(branch)
  return { branch, worktreePath, existing }
})

ipcMain.handle('worktree:isDirty', (_, branch) => {
  return { dirty: worktreeManager.isDirty(branch) }
})

ipcMain.handle('worktree:remove', (_, branch, force) => {
  worktreeManager.remove(branch, { force })
  return { ok: true }
})

// Session lifecycle
ipcMain.handle('session:getCwd', (_, sessionId) => {
  return ptyManager.getCwd(sessionId)
})

ipcMain.handle('session:kill', (_, sessionId) => {
  ptyManager.kill(sessionId)
  jsonlWatcher.stopWatching(sessionId)
  return { ok: true }
})

ipcMain.handle('session:spawn', (_, sessionId, opts) => {
  const cwd = opts.cwd || process.cwd()

  const existingFiles = jsonlWatcher.snapshotFiles()

  ptyManager.spawn(sessionId, { cwd, autoLaunch: true, initialPrompt: opts.initialPrompt })

  jsonlWatcher.startWatching(sessionId, { existingFiles, cwd })

  ptyManager.onThinking(sessionId, (sid) => {
    jsonlWatcher.notifyThinking(sid)
  })
  ptyManager.onPermissionPrompt(sessionId, (sid) => {
    jsonlWatcher.notifyPermissionPrompt(sid)
  })
  ptyManager.onShellReturn(sessionId, (sid) => {
    jsonlWatcher.notifyShellReturn(sid)
  })

  return { sessionId, cwd }
})

// ─── Window ─────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  ptyManager.killAll()
  jsonlWatcher.stopAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
