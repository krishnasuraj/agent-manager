import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import { createPtyManager } from './ptyManager.js'
import { createJsonlWatcher } from './jsonlWatcher.js'
import { worktreeCreate, worktreeRemove, worktreeIsDirty } from './worktreeManager.js'
import { getAllToolConfigs, getAvailableTools } from './toolConfigs.js'

// Scrub env vars for all tools so child processes don't inherit nesting detection
for (const tc of getAllToolConfigs()) {
  if (!tc.envPrefixToScrub) continue
  const prefix = tc.envPrefixToScrub.toUpperCase()
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().includes(prefix)) {
      delete process.env[key]
    }
  }
}

// Parse --test-sessions=N from CLI args
const testSessionsArg = process.argv.find((a) => a.startsWith('--test-sessions='))
const testSessionCount = testSessionsArg ? parseInt(testSessionsArg.split('=')[1], 10) || 0 : 0

let mainWindow = null
let memoryMonitorInterval = null

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

function getActiveWindow() {
  return mainWindow || BrowserWindow.getAllWindows()[0]
}

async function pickDirectory() {
  const win = getActiveWindow()
  if (!win) return null
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
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
  const dirPath = await pickDirectory()
  if (!dirPath) return null
  return addWorkspace(dirPath)
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

// Available tools
ipcMain.handle('tools:list', () => getAvailableTools())

// Folder picker
ipcMain.handle('dialog:pick-folder', () => pickDirectory())

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
  const toolId = opts.toolId || 'claude'

  const existingFiles = jsonlWatcher.snapshotFiles(toolId)

  ptyManager.spawn(sessionId, { cwd, toolId, autoLaunch: true, initialPrompt: opts.initialPrompt })

  jsonlWatcher.startWatching(sessionId, { toolId, existingFiles, cwd })

  ptyManager.onStartup(sessionId, (sid) => {
    jsonlWatcher.notifyStartup(sid)
  })
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

// ─── Memory monitor ───────────────────────────────────────────────

function startMemoryMonitor() {
  if (memoryMonitorInterval) return
  sendMetrics()
  memoryMonitorInterval = setInterval(sendMetrics, 2000)
}

function stopMemoryMonitor() {
  if (!memoryMonitorInterval) return
  clearInterval(memoryMonitorInterval)
  memoryMonitorInterval = null
}

function sendMetrics() {
  const win = mainWindow || BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return

  const metrics = app.getAppMetrics()
  const electronKB = metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0)
  const mainKB = metrics.find(m => m.type === 'Browser')?.memory.workingSetSize || 0
  const rendererKB = metrics.filter(m => m.type === 'Tab' || m.type === 'Renderer').reduce((sum, m) => sum + m.memory.workingSetSize, 0)

  // Get PTY shell PIDs and walk their descendant trees for claude process memory
  const ptyPids = ptyManager.getPids()
  if (ptyPids.length === 0) {
    win.webContents.send('debug:memory', { totalKB: electronKB, electronKB, mainKB, rendererKB, agentsKB: 0 })
    return
  }

  // ps -eo pid,ppid,rss lists RSS (in KB) for all processes; filter to descendants of PTY pids
  execFile('ps', ['-eo', 'pid,ppid,rss'], (err, stdout) => {
    if (err) {
      win.webContents.send('debug:memory', { totalKB: electronKB, electronKB, mainKB, rendererKB, agentsKB: 0 })
      return
    }

    const procs = new Map()
    for (const line of stdout.trim().split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 3) {
        procs.set(parseInt(parts[0]), { ppid: parseInt(parts[1]), rss: parseInt(parts[2]) || 0 })
      }
    }

    // Collect all descendant PIDs of our PTY shell roots
    const descendants = new Set()
    const queue = [...ptyPids]
    while (queue.length > 0) {
      const pid = queue.pop()
      descendants.add(pid)
      for (const [childPid, info] of procs) {
        if (info.ppid === pid && !descendants.has(childPid)) {
          queue.push(childPid)
        }
      }
    }

    let agentsKB = 0
    for (const pid of descendants) {
      agentsKB += procs.get(pid)?.rss || 0
    }

    const totalKB = electronKB + agentsKB
    win.webContents.send('debug:memory', { totalKB, electronKB, mainKB, rendererKB, agentsKB })
  })
}

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
            const dirPath = await pickDirectory()
            if (dirPath) addWorkspace(dirPath)
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
        {
          label: 'Board View',
          accelerator: 'CmdOrCtrl+1',
          click: () => {
            getActiveWindow()?.webContents.send('menu:view', 'board')
          },
        },
        {
          label: 'Agent View',
          accelerator: 'CmdOrCtrl+2',
          click: () => {
            getActiveWindow()?.webContents.send('menu:view', 'agent')
          },
        },
        { type: 'separator' },
        {
          label: 'Toggle Memory Monitor',
          click: () => {
            if (memoryMonitorInterval) {
              stopMemoryMonitor()
              getActiveWindow()?.webContents.send('debug:memory', null)
            } else {
              startMemoryMonitor()
            }
          },
        },
        { type: 'separator' },
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

// ─── Update check ─────────────────────────────────────────────────
// Check GitHub for a newer release and prompt the user to download it.

const REPO = 'krishnasuraj/agent-manager'

async function checkForUpdates() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    if (!res.ok) return
    const release = await res.json()
    const latest = release.tag_name?.replace(/^v/, '')
    const current = app.getVersion()
    if (!latest || latest === current) return

    const [cMaj, cMin, cPatch] = current.split('.').map(Number)
    const [lMaj, lMin, lPatch] = latest.split('.').map(Number)
    const isNewer = lMaj > cMaj || (lMaj === cMaj && lMin > cMin) || (lMaj === cMaj && lMin === cMin && lPatch > cPatch)
    if (!isNewer) return

    const win = getActiveWindow()
    if (!win) return
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update Available',
      message: `Version ${latest} is available (you have ${current}).`,
      detail: 'Would you like to open the download page?',
      buttons: ['Download', 'Later'],
      defaultId: 0,
    })
    if (response === 0) {
      shell.openExternal(release.html_url)
    }
  } catch (err) {
    console.error('Update check failed:', err)
  }
}

app.whenReady().then(() => {
  buildMenu()
  createWindow()

  // Check for updates (skip in dev)
  if (!process.env.ELECTRON_RENDERER_URL) {
    checkForUpdates()
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
