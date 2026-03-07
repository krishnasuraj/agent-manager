const DOT = {
  working: 'bg-status-running animate-pulse',
  'needs-input': 'bg-status-guidance animate-pulse',
  idle: 'bg-surface-3',
  done: 'bg-status-merged',
  error: 'bg-red-500',
}

export default function SessionList({ sessions, activeSessionId, onSelect, onClose }) {
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
            className={`group px-4 py-2.5 cursor-pointer flex items-start gap-3 transition-colors ${
              isActive ? 'bg-surface-1' : 'hover:bg-surface-1/50'
            }`}
          >
            <span className={`h-2 w-2 rounded-full mt-1.5 shrink-0 ${dotClass}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className={`text-xs font-mono ${isActive ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>
                  {session.branch ? session.branch : session.name}
                </p>
              </div>
              {session.lastEvent && (
                <p className="text-xs font-mono text-text-muted truncate mt-0.5">
                  {session.lastEvent}
                </p>
              )}
            </div>
            {onClose && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(session.id)
                }}
                className="text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-xs mt-0.5 shrink-0"
                title="Close session"
              >
                ✕
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
