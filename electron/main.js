import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import { createPtyManager } from './ptyManager.js'
import { createJsonlWatcher } from './jsonlWatcher.js'

// Scrub Claude env vars so child processes don't inherit nesting detection
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().includes('CLAUDE')) {
    delete process.env[key]
  }
}

let mainWindow = null

function getWindow() {
  return mainWindow
}

const ptyManager = createPtyManager(getWindow)
const jsonlWatcher = createJsonlWatcher(getWindow)

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

  // IPC: PTY input from renderer
  ipcMain.on('pty:write', (_, sessionId, data) => {
    ptyManager.write(sessionId, data)
  })

  ipcMain.on('pty:resize', (_, sessionId, cols, rows) => {
    ptyManager.resize(sessionId, cols, rows)
  })

  // IPC: List recent Claude sessions for a given directory
  ipcMain.handle('sessions:list-recent', (_, cwd) => {
    return jsonlWatcher.listRecentSessions(cwd || process.cwd())
  })

  // IPC: Native folder picker
  ipcMain.handle('dialog:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // IPC: Spawn a new session (fresh or resumed)
  ipcMain.handle('session:spawn', (_, sessionId, opts) => {
    const cwd = opts.cwd || process.cwd()
    const claudeSessionId = opts.claudeSessionId || null

    // Both new and resumed sessions use snapshot-based file detection.
    // Claude --resume creates a NEW .jsonl file (different UUID from the original),
    // so we can't just lock to <sessionId>.jsonl — we must detect the new file.
    const existingFiles = jsonlWatcher.snapshotFiles(cwd)

    if (claudeSessionId) {
      ptyManager.spawn(sessionId, { cwd, claudeSessionId })
    } else {
      ptyManager.spawn(sessionId, { cwd, initialPrompt: opts.initialPrompt })
    }

    jsonlWatcher.startWatching(sessionId, cwd, { existingFiles })

    // Wire PTY signals → JSONL watcher for instant state transitions
    ptyManager.onThinking(sessionId, (sid) => {
      jsonlWatcher.notifyThinking(sid)
    })
    ptyManager.onPermissionPrompt(sessionId, (sid) => {
      jsonlWatcher.notifyPermissionPrompt(sid)
    })

    return { sessionId, cwd }
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
