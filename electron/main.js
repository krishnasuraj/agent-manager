import { app, BrowserWindow } from 'electron'
import path from 'path'
import { createTaskStore } from './taskStore.js'
import { createClaudeManager } from './claudeManager.js'
import { registerIpcHandlers } from './ipc.js'
import { seedTasks } from './seed.js'

// Scrub Claude env vars from the main process so child processes
// don't inherit nesting detection vars (allows running from inside Claude Code)
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().includes('CLAUDE')) {
    delete process.env[key]
  }
}

let mainWindow = null

const taskStore = createTaskStore()

function getWindow() {
  return mainWindow
}

const claudeManager = createClaudeManager(taskStore, getWindow)

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

  registerIpcHandlers(taskStore, claudeManager, getWindow)

  taskStore.onChange((task) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task:updated', task)
    }
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

  // Auto-seed tasks if --seed flag is present
  const seedFlag = process.argv.includes('--seed')
  if (seedFlag) {
    // Wait for renderer to be ready before seeding
    mainWindow.webContents.on('did-finish-load', () => {
      seedTasks(taskStore, claudeManager, getWindow)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  claudeManager.stopAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
