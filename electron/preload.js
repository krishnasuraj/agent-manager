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

  // Worktree (parameterized by workspace)
  worktreeCreate: (workspace, branch) => ipcRenderer.invoke('worktree:create', workspace, branch),
  worktreeIsDirty: (workspace, branch) => ipcRenderer.invoke('worktree:isDirty', workspace, branch),
  worktreeRemove: (workspace, branch, force) => ipcRenderer.invoke('worktree:remove', workspace, branch, force),

  // Session lifecycle
  spawnSession: (sessionId, opts) => ipcRenderer.invoke('session:spawn', sessionId, opts),
  killSession: (sessionId) => ipcRenderer.invoke('session:kill', sessionId),
  getSessionCwd: (sessionId) => ipcRenderer.invoke('session:getCwd', sessionId),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),

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
  onJsonlSessionStarted: (cb) => {
    const handler = (_, sessionId) => cb(sessionId)
    ipcRenderer.on('jsonl:session-started', handler)
    return () => ipcRenderer.removeListener('jsonl:session-started', handler)
  },
})
