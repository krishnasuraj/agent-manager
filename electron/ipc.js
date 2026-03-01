import { ipcMain } from 'electron'

export function registerIpcHandlers(taskStore, claudeManager, getWindow) {
  ipcMain.handle('tasks:getAll', () => {
    return taskStore.getAll()
  })

  ipcMain.handle('tasks:create', (_, { title, baseBranch, prompt }) => {
    if (!title) throw new Error('Title is required')
    const task = taskStore.create({ title, baseBranch })

    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('task:created', task)
    }

    // Auto-start Claude session in the worktree
    try {
      claudeManager.startSession(task.id)
      // If an initial prompt was provided, send it
      if (prompt && prompt.trim()) {
        claudeManager.sendMessage(task.id, prompt.trim())
      }
    } catch (err) {
      console.error('[ipc] session auto-start failed:', err.message)
    }
    return task
  })

  ipcMain.handle('tasks:delete', (_, taskId) => {
    claudeManager.stopSession(taskId)
    const deleted = taskStore.delete(taskId)
    if (deleted) {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('task:deleted', taskId)
      }
    }
    return deleted
  })

  ipcMain.handle('session:send-message', (_, { taskId, text }) => {
    claudeManager.sendMessage(taskId, text)
    return true
  })

  // Fire-and-forget: abort current Claude response
  ipcMain.on('session:abort', (_, taskId) => {
    claudeManager.abort(taskId)
  })
}
