import { randomUUID } from 'crypto'

/** @typedef {'idle'|'in-progress'|'input-required'|'completed'} TaskStatus */

export function createTaskStore() {
  const tasks = new Map()
  const listeners = new Set()

  function notify(task) {
    for (const fn of listeners) fn(task)
  }

  return {
    create({ title, baseBranch }) {
      const id = randomUUID()
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40)

      const task = {
        id,
        title,
        status: 'idle',
        branch: `feat/${slug}`,
        baseBranch: baseBranch || 'main',
        worktreePath: null,
        messages: [],
        tokenUsage: { input: 0, output: 0 },
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      tasks.set(id, task)
      return task
    },

    get(id) {
      return tasks.get(id) || null
    },

    getAll() {
      return [...tasks.values()]
    },

    update(id, fields) {
      const task = tasks.get(id)
      if (!task) return null
      Object.assign(task, fields, { updatedAt: Date.now() })
      notify(task)
      return task
    },

    delete(id) {
      const task = tasks.get(id)
      if (!task) return false
      tasks.delete(id)
      return true
    },

    appendMessage(id, message) {
      const task = tasks.get(id)
      if (!task) return null
      task.messages = [...task.messages, message]
      task.updatedAt = Date.now()
      notify(task)
      return task
    },

    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
