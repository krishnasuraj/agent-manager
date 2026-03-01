import { useState } from 'react'

const baseBranches = ['main', 'develop']

export default function TaskModal({ onClose, onCreateTask }) {
  const [title, setTitle] = useState('')
  const [baseBranch, setBaseBranch] = useState('main')
  const [prompt, setPrompt] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) return
    await onCreateTask({ title: title.trim(), baseBranch, prompt: prompt.trim() })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-text-primary">New Task</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary transition-colors cursor-pointer">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short name for the task"
              className="w-full rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-border-bright transition-colors"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Base Branch
              <span className="ml-1.5 font-normal text-text-muted">- agent works in an isolated worktree</span>
            </label>
            <select
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm text-text-primary outline-none focus:border-border-bright transition-colors cursor-pointer"
            >
              {baseBranches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Prompt
              <span className="ml-1.5 font-normal text-text-muted">- initial message to send to Claude</span>
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the task for Claude..."
              rows={3}
              className="w-full rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-border-bright transition-colors resize-none font-mono"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim()}
              className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-text-primary hover:bg-white/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Create Task
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
