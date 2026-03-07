import { useState, useEffect, useRef, useCallback } from 'react'
import TerminalPanel from './components/TerminalPanel'
import StateLog from './components/StateLog'
import SessionList from './components/SessionList'
import ResizableSplit from './components/ResizableSplit'

export default function App() {
  const [sessions, setSessions] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(null)
  const sessionCounter = useRef(0)
  const spawned = useRef(false)

  const spawnSession = useCallback(async (cwd) => {
    sessionCounter.current += 1
    const id = `session-${Date.now()}`
    const name = `Session ${sessionCounter.current}`
    setSessions(prev => [...prev, { id, name, claudeActive: false, state: null, lastEvent: null }])
    setActiveSessionId(id)
    try {
      await window.electronAPI.spawnSession(id, cwd ? { cwd } : {})
    } catch (err) {
      console.error('Failed to spawn session:', err)
    }
  }, [])

  // Auto-spawn first session on mount
  useEffect(() => {
    if (spawned.current) return
    spawned.current = true
    spawnSession()
  }, [spawnSession])

  // Global IPC listeners
  useEffect(() => {
    const removeStarted = window.electronAPI.onJsonlSessionStarted((id) => {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, claudeActive: true } : s))
    })
    const removeEnded = window.electronAPI.onJsonlSessionEnded((id) => {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, claudeActive: false, state: null } : s))
    })
    const removeState = window.electronAPI.onJsonlState((id, state) => {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, state } : s))
    })
    const removeEvent = window.electronAPI.onJsonlEvent((id, entry) => {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, lastEvent: entry.label } : s))
    })
    return () => {
      removeStarted()
      removeEnded()
      removeState()
      removeEvent()
    }
  }, [])

  const handleNewSession = async () => {
    // Default to the most recent session's current working directory
    let cwd
    if (sessions.length > 0) {
      const lastSession = sessions[sessions.length - 1]
      try {
        cwd = await window.electronAPI.getSessionCwd(lastSession.id)
      } catch {}
    }
    await spawnSession(cwd || undefined)
  }

  const sidebar = (
    <div className="flex flex-col h-full min-h-0">
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
      />
      <div className="flex-1 min-h-0 relative">
        {sessions.map(session => (
          <div
            key={session.id}
            className={`absolute inset-0 ${session.id === activeSessionId ? 'flex flex-col' : 'hidden'}`}
          >
            <StateLog sessionId={session.claudeActive ? session.id : null} />
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-text-muted">No sessions yet</p>
          </div>
        )}
      </div>
    </div>
  )

  const terminals = (
    <div className="relative h-full">
      {sessions.map(session => (
        <div
          key={session.id}
          className={`absolute inset-0 ${session.id === activeSessionId ? 'block' : 'hidden'}`}
        >
          <TerminalPanel sessionId={session.id} active={session.id === activeSessionId} />
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-surface-0">
      <div
        className="flex items-center justify-between border-b border-border px-4 py-2 shrink-0"
        style={{ WebkitAppRegion: 'drag' }}
      >
        <span className="text-xs font-medium text-text-secondary">Claude Code Orchestrator</span>
        <button
          onClick={handleNewSession}
          style={{ WebkitAppRegion: 'no-drag' }}
          className="text-xs text-text-muted hover:text-text-primary border border-border hover:border-border-bright rounded px-2 py-1 transition-colors"
        >
          + New Session
        </button>
      </div>

      <ResizableSplit
        left={sidebar}
        right={terminals}
        defaultRatio={0.3}
        minLeftPx={250}
        minRightPx={400}
      />
    </div>
  )
}
