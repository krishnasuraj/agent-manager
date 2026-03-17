import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // PTY
  onPtyData: (cb) => {
    const handler = (_, sessionId, data) => cb(sessionId, data)
    ipcRenderer.on('pty:data', handler)
    return () => ipcRenderer.removeListener('pty:data', handler)
  },
  onPtyExit: (cb) => {
    const handler = (_, sessionId, info) => cb(sessionId, info)
    ipcRenderer.on('pty:exit', handler)
    return () => ipcRenderer.removeListener('pty:exit', handler)
  },
  ptyWrite: (sessionId, data) => ipcRenderer.send('pty:write', sessionId, data),
  ptyResize: (sessionId, cols, rows) => ipcRenderer.send('pty:resize', sessionId, cols, rows),

  // App config
  getTestConfig: () => ipcRenderer.invoke('app:getTestConfig'),
  getAppCwd: () => ipcRenderer.invoke('app:getCwd'),

  // Workspaces
  getWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  addWorkspaceViaDialog: () => ipcRenderer.invoke('workspace:add-via-dialog'),
  onWorkspacesChanged: (cb) => {
    const handler = (_, workspaces) => cb(workspaces)
    ipcRenderer.on('workspaces:changed', handler)
    return () => ipcRenderer.removeListener('workspaces:changed', handler)
  },

  // Menu events
  onMenuNewAgent: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('menu:new-agent', handler)
    return () => ipcRenderer.removeListener('menu:new-agent', handler)
  },
  onMenuView: (cb) => {
    const handler = (_e, view) => cb(view)
    ipcRenderer.on('menu:view', handler)
    return () => ipcRenderer.removeListener('menu:view', handler)
  },
  onMenuNewTerminal: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('menu:new-terminal', handler)
    return () => ipcRenderer.removeListener('menu:new-terminal', handler)
  },
  onMenuSettings: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('menu:settings', handler)
    return () => ipcRenderer.removeListener('menu:settings', handler)
  },
  onNotificationSelectAgent: (cb) => {
    const handler = (_, sessionId) => cb(sessionId)
    ipcRenderer.on('notification:select-agent', handler)
    return () => ipcRenderer.removeListener('notification:select-agent', handler)
  },

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),

  // Worktree (parameterized by workspace)
  worktreeCreate: (workspace, branch) => ipcRenderer.invoke('worktree:create', workspace, branch),
  worktreeIsDirty: (workspace, branch) => ipcRenderer.invoke('worktree:isDirty', workspace, branch),
  worktreeRemove: (workspace, branch, force) => ipcRenderer.invoke('worktree:remove', workspace, branch, force),
  worktreeList: (workspace) => ipcRenderer.invoke('worktree:list', workspace),

  // Tools
  getAvailableTools: () => ipcRenderer.invoke('tools:list'),

  // Session lifecycle
  spawnSession: (sessionId, opts) => ipcRenderer.invoke('session:spawn', sessionId, opts),
  killSession: (sessionId) => ipcRenderer.invoke('session:kill', sessionId),
  getSessionCwd: (sessionId) => ipcRenderer.invoke('session:getCwd', sessionId),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // JSONL state
  onJsonlEvent: (cb) => {
    const handler = (_, sessionId, entry) => cb(sessionId, entry)
    ipcRenderer.on('jsonl:event', handler)
    return () => ipcRenderer.removeListener('jsonl:event', handler)
  },
  onJsonlState: (cb) => {
    const handler = (_, sessionId, state) => cb(sessionId, state)
    ipcRenderer.on('jsonl:state', handler)
    return () => ipcRenderer.removeListener('jsonl:state', handler)
  },
  onJsonlSessionEnded: (cb) => {
    const handler = (_, sessionId) => cb(sessionId)
    ipcRenderer.on('jsonl:session-ended', handler)
    return () => ipcRenderer.removeListener('jsonl:session-ended', handler)
  },
  // Terminal cwd tracking
  onTerminalCwd: (cb) => {
    const handler = (_, sessionId, cwd) => cb(sessionId, cwd)
    ipcRenderer.on('terminal:cwd', handler)
    return () => ipcRenderer.removeListener('terminal:cwd', handler)
  },

  // Debug
  onDebugMemory: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('debug:memory', handler)
    return () => ipcRenderer.removeListener('debug:memory', handler)
  },

  onJsonlSessionStarted: (cb) => {
    const handler = (_, sessionId) => cb(sessionId)
    ipcRenderer.on('jsonl:session-started', handler)
    return () => ipcRenderer.removeListener('jsonl:session-started', handler)
  },
})
