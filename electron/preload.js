import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Tasks
  getTasks: () => ipcRenderer.invoke('tasks:getAll'),
  createTask: (data) => ipcRenderer.invoke('tasks:create', data),
  deleteTask: (taskId) => ipcRenderer.invoke('tasks:delete', taskId),

  onTaskCreated: (cb) => {
    const handler = (_, task) => cb(task)
    ipcRenderer.on('task:created', handler)
    return () => ipcRenderer.removeListener('task:created', handler)
  },
  onTaskUpdated: (cb) => {
    const handler = (_, task) => cb(task)
    ipcRenderer.on('task:updated', handler)
    return () => ipcRenderer.removeListener('task:updated', handler)
  },
  onTaskDeleted: (cb) => {
    const handler = (_, taskId) => cb(taskId)
    ipcRenderer.on('task:deleted', handler)
    return () => ipcRenderer.removeListener('task:deleted', handler)
  },

  // Session
  sendMessage: (taskId, text) =>
    ipcRenderer.invoke('session:send-message', { taskId, text }),
  abortSession: (taskId) =>
    ipcRenderer.send('session:abort', taskId),
  onSessionEvent: (taskId, cb) => {
    const channel = `session:event:${taskId}`
    const handler = (_, event) => cb(event)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
})
