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

  // Worktree
  worktreeCreate: (branch) => ipcRenderer.invoke('worktree:create', branch),
  worktreeIsDirty: (branch) => ipcRenderer.invoke('worktree:isDirty', branch),
  worktreeRemove: (branch, force) => ipcRenderer.invoke('worktree:remove', branch, force),

  // Session lifecycle
  spawnSession: (sessionId, opts) => ipcRenderer.invoke('session:spawn', sessionId, opts),
  killSession: (sessionId) => ipcRenderer.invoke('session:kill', sessionId),
  getSessionCwd: (sessionId) => ipcRenderer.invoke('session:getCwd', sessionId),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  listRecentSessions: (cwd) => ipcRenderer.invoke('sessions:list-recent', cwd),

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
