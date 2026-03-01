import { useState, useEffect, useMemo, useCallback } from 'react'

export function useTasks() {
  const [tasks, setTasks] = useState([])

  useEffect(() => {
    window.electronAPI.getTasks().then(setTasks)

    const removeCreated = window.electronAPI.onTaskCreated((task) => {
      setTasks((prev) => [...prev, task])
    })

    const removeUpdated = window.electronAPI.onTaskUpdated((task) => {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)))
    })

    const removeDeleted = window.electronAPI.onTaskDeleted((taskId) => {
      setTasks((prev) => prev.filter((t) => t.id !== taskId))
    })

    return () => {
      removeCreated()
      removeUpdated()
      removeDeleted()
    }
  }, [])

  const createTask = useCallback(({ title, baseBranch, prompt }) => {
    return window.electronAPI.createTask({ title, baseBranch, prompt })
  }, [])

  const deleteTask = useCallback((taskId) => {
    return window.electronAPI.deleteTask(taskId)
  }, [])

  const inputRequiredCount = useMemo(
    () => tasks.filter((t) => t.status === 'input-required').length,
    [tasks],
  )

  return { tasks, createTask, deleteTask, inputRequiredCount }
}
