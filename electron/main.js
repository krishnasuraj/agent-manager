import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import path from 'path'
import fs from 'fs'
import { autoUpdater } from 'electron-updater'
import { createPtyManager } from './ptyManager.js'
import { createJsonlWatcher } from './jsonlWatcher.js'
import { worktreeCreate, worktreeRemove, worktreeIsDirty } from './worktreeManager.js'

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

// ─── Workspace management ─────────────────────────────────────────

const workspaces = [] // [{ path: string, name: string }]

function isGitRepo(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'))
  } catch {
    return false
  }
}

function addWorkspace(dirPath) {
  const resolved = path.resolve(dirPath)
  const existing = workspaces.find((w) => w.path === resolved)
  if (existing) return existing
  const ws = { path: resolved, name: path.basename(resolved), isGit: isGitRepo(resolved) }
  workspaces.push(ws)
  mainWindow?.webContents.send('workspaces:changed', workspaces)
  return ws
}

// Auto-add cwd as workspace if it's a git repo
if (isGitRepo(process.cwd())) {
  addWorkspace(process.cwd())
}

// ─── IPC handlers (registered once, outside createWindow) ───────────

// PTY input from renderer
ipcMain.on('pty:write', (_, sessionId, data) => {
  ptyManager.write(sessionId, data)
})

ipcMain.on('pty:resize', (_, sessionId, cols, rows) => {
  ptyManager.resize(sessionId, cols, rows)
})

ipcMain.handle('app:getCwd', () => process.cwd())

// Workspaces
ipcMain.handle('workspace:list', () => workspaces)

ipcMain.handle('workspace:add-via-dialog', async () => {
  const win = mainWindow || BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  return addWorkspace(result.filePaths[0])
})

// Test config
ipcMain.handle('app:getTestConfig', () => {
  const testCwds = []
  const testBranches = []
  for (let i = 0; i < testSessionCount; i++) {
    const branch = `test-${i + 1}`
    const { worktreePath } = worktreeCreate(process.cwd(), branch)
    testCwds.push(worktreePath)
    testBranches.push(branch)
  }
  return { testSessions: testSessionCount, testCwds, testBranches }
})

// Worktree operations — parameterized by workspace path
ipcMain.handle('worktree:create', (_, workspace, branch) => {
  const { worktreePath, existing } = worktreeCreate(workspace, branch)
  return { branch, worktreePath, existing }
})

ipcMain.handle('worktree:isDirty', (_, workspace, branch) => {
  return { dirty: worktreeIsDirty(workspace, branch) }
})

ipcMain.handle('worktree:remove', (_, workspace, branch, force) => {
  worktreeRemove(workspace, branch, { force })
  return { ok: true }
})

// Folder picker
ipcMain.handle('dialog:pick-folder', async () => {
  const win = mainWindow || BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
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

// ─── Menu ─────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Agent',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow?.webContents.send('menu:new-agent')
          },
        },
        { type: 'separator' },
        {
          label: 'Add Workspace…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const win = mainWindow || BrowserWindow.getAllWindows()[0]
            if (!win) return
            const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
            if (result.canceled || result.filePaths.length === 0) return
            addWorkspace(result.filePaths[0])
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [{ type: 'separator' }, { role: 'front' }]
          : []),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

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

// ─── Auto-update ──────────────────────────────────────────────────

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info.version)
})

autoUpdater.on('update-downloaded', (info) => {
  const win = mainWindow || BrowserWindow.getAllWindows()[0]
  if (!win) return
  dialog
    .showMessageBox(win, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'Restart the app to apply the update.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    })
    .then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall()
      }
    })
})

autoUpdater.on('error', (err) => {
  console.error('Auto-update error:', err)
})

app.whenReady().then(() => {
  buildMenu()
  createWindow()

  // Check for updates (skip in dev)
  if (!process.env.ELECTRON_RENDERER_URL) {
    autoUpdater.checkForUpdates().catch(() => {})
  }

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
