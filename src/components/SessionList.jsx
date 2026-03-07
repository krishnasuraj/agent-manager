const DOT = {
  working: 'bg-status-running animate-pulse',
  'needs-input': 'bg-status-guidance animate-pulse',
  idle: 'bg-surface-3',
  done: 'bg-status-merged',
  error: 'bg-red-500',
}

export default function SessionList({ sessions, activeSessionId, onSelect }) {
  return (
    <div className="border-b border-border shrink-0">
      {sessions.map((session) => {
        const isActive = session.id === activeSessionId
        const stateKey = session.state?.state || (session.claudeActive ? 'idle' : null)
        const dotClass = stateKey ? (DOT[stateKey] || DOT.idle) : 'bg-surface-2'

        return (
          <div
            key={session.id}
            onClick={() => onSelect(session.id)}
            className={`px-4 py-2.5 cursor-pointer flex items-start gap-3 transition-colors ${
              isActive ? 'bg-surface-1' : 'hover:bg-surface-1/50'
            }`}
          >
            <span className={`h-2 w-2 rounded-full mt-1.5 shrink-0 ${dotClass}`} />
            <div className="min-w-0 flex-1">
              <p className={`text-xs ${isActive ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>
                {session.name}
              </p>
              {session.lastEvent && (
                <p className="text-xs font-mono text-text-muted truncate mt-0.5">
                  {session.lastEvent}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
