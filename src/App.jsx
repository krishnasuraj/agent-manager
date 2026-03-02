import { useState, useCallback, useEffect } from 'react'
import TerminalPanel from './components/TerminalPanel'
import StateLog from './components/StateLog'
import ResizableSplit from './components/ResizableSplit'

export default function App() {
  const [sessionId, setSessionId] = useState(null)
  const [sessionCwd, setSessionCwd] = useState('')
  const [resumeId, setResumeId] = useState('')
  const [recentSessions, setRecentSessions] = useState([])

  // Load recent sessions when cwd changes
  useEffect(() => {
    const load = async () => {
      try {
        const sessions = await window.electronAPI.listRecentSessions(sessionCwd.trim() || undefined)
        setRecentSessions(sessions || [])
      } catch {
        setRecentSessions([])
      }
    }
    load()
  }, [sessionCwd])

  const handleSpawn = useCallback(async (claudeSessionId) => {
    const id = `session-${Date.now()}`
    const cwd = sessionCwd.trim() || undefined

    try {
      await window.electronAPI.spawnSession(id, { cwd, claudeSessionId: claudeSessionId || undefined })
      setSessionId(id)
    } catch (err) {
      console.error('Failed to spawn session:', err)
    }
  }, [sessionCwd])

  if (!sessionId) {
    return (
      <div className="flex flex-col h-screen items-center justify-center bg-surface-0 gap-6">
        <div className="text-center">
          <h1 className="text-lg font-semibold text-text-primary">Claude Code Orchestrator</h1>
          <p className="text-xs text-text-muted mt-1">Stage 1: Terminal + JSONL Proof of Concept</p>
        </div>

        <div className="flex flex-col gap-3 w-96">
          <div className="flex gap-2">
            <input
              type="text"
              value={sessionCwd}
              onChange={(e) => setSessionCwd(e.target.value)}
              placeholder="Working directory (default: current)"
              className="flex-1 rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-border-bright transition-colors font-mono"
            />
            <button
              onClick={async () => {
                const folder = await window.electronAPI.pickFolder()
                if (folder) setSessionCwd(folder)
              }}
              className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors cursor-pointer shrink-0"
              title="Browse..."
            >
              ...
            </button>
          </div>

          <button
            onClick={() => handleSpawn(null)}
            className="rounded-lg bg-white/10 px-4 py-2.5 text-sm font-medium text-text-primary hover:bg-white/15 transition-colors cursor-pointer"
          >
            New Session
          </button>

          <div className="border-t border-border pt-3 mt-1">
            <p className="text-xs text-text-muted mb-2">Or resume a recent session:</p>
            {recentSessions.length > 0 ? (
              <div className="flex flex-col gap-1 max-h-52 overflow-y-auto">
                {recentSessions.map((s) => (
                  <button
                    key={s.sessionId}
                    onClick={() => handleSpawn(s.sessionId)}
                    className="text-left rounded-lg border border-border bg-surface-1 px-3 py-2 hover:bg-surface-2 hover:border-border-bright transition-colors cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-text-secondary truncate">{s.sessionId.slice(0, 8)}...</span>
                      <span className="text-xs text-text-muted shrink-0">
                        {new Date(s.lastModified).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
                        {new Date(s.lastModified).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-xs text-text-muted mt-0.5 truncate">{s.preview}</p>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted text-center py-3">No recent sessions found</p>
            )}
            <div className="flex gap-2 mt-2">
              <input
                type="text"
                value={resumeId}
                onChange={(e) => setResumeId(e.target.value)}
                placeholder="Or paste session ID"
                className="flex-1 rounded-lg border border-border bg-surface-1 px-3 py-2 text-xs text-text-primary placeholder-text-muted outline-none focus:border-border-bright transition-colors font-mono"
              />
              <button
                onClick={() => handleSpawn(resumeId.trim())}
                disabled={!resumeId.trim()}
                className="rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-text-primary hover:bg-white/15 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
              >
                Resume
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const sidebar = <StateLog sessionId={sessionId} />
  const terminal = <TerminalPanel sessionId={sessionId} />

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-surface-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-2 shrink-0" style={{ WebkitAppRegion: 'drag' }}>
        <span className="text-xs font-medium text-text-secondary">Claude Code Orchestrator</span>
        <span className="text-xs font-mono text-text-muted">{sessionId}</span>
      </div>

      <ResizableSplit
        left={sidebar}
        right={terminal}
        defaultRatio={0.3}
        minLeftPx={250}
        minRightPx={400}
      />
    </div>
  )
}
