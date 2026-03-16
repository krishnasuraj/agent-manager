const DOT = {
  working: 'bg-status-running animate-pulse',
  'needs-input': 'bg-status-guidance animate-pulse',
  idle: 'bg-surface-3',
  done: 'bg-status-merged',
  error: 'bg-red-500',
}

export default function SessionList({ sessions, activeSessionId, onSelect, onClose, showWorkspace }) {
  return (
    <div className="border-b border-border shrink-0">
      {sessions.map((session, i) => {
        const isActive = session.id === activeSessionId
        const stateKey = session.state?.state || (session.claudeActive ? 'idle' : null)
        const dotClass = stateKey ? (DOT[stateKey] || DOT.idle) : 'bg-surface-2'
        const shortcutKey = i < 9 ? String(i + 1) : i === 9 ? '0' : null

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
                {session.toolId && (
                  <span
                    className="text-[9px] font-mono rounded px-1 py-0.5"
                    style={{
                      color: session.toolId === 'claude' ? '#E07A47'
                        : session.toolId === 'terminal' ? '#888' : '#7300ff',
                      backgroundColor: session.toolId === 'claude' ? 'rgba(224,122,71,0.15)'
                        : session.toolId === 'terminal' ? 'rgba(136,136,136,0.15)' : 'rgba(115,0,255,0.15)',
                    }}
                  >
                    {session.toolId === 'terminal' ? 'terminal' : session.toolId}
                  </span>
                )}
                {shortcutKey && (
                  <span className="text-[10px] font-mono text-text-muted opacity-60 ml-auto shrink-0">
                    ctrl-{shortcutKey}
                  </span>
                )}
              </div>
              {showWorkspace && session.workspace && (
                <p className="text-[10px] text-text-muted truncate">
                  {session.workspace.split('/').pop()}
                </p>
              )}
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
