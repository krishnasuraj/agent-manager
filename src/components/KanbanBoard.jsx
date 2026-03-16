import { useState } from 'react'

const COLUMNS = [
  { key: 'idle', label: 'Idle', dotClass: 'bg-surface-3', color: 'text-text-muted' },
  { key: 'working', label: 'Working', dotClass: 'bg-status-running', color: 'text-status-running' },
  { key: 'needs-input', label: 'Needs Input', dotClass: 'bg-status-guidance', color: 'text-status-guidance' },
]

function getColumnKey(session) {
  if (session.toolId === 'terminal') return 'terminal'
  const state = session.state?.state
  if (state === 'working') return 'working'
  if (state === 'needs-input') return 'needs-input'
  return 'idle'
}

function SessionCard({ session, col, collapsedIds, setCollapsedIds, sessionIndex, onSelectAgent, onClose, showWorkspace }) {
  const defaultExpanded = col.key === 'needs-input'
  const isExpanded = defaultExpanded ? !collapsedIds.has(session.id) : collapsedIds.has(session.id)
  const stateLabel = session.toolId === 'terminal' ? 'terminal' : (session.state?.state || (session.claudeActive ? 'idle' : 'not started'))
  const stateSummary = session.state?.summary || ''

  return (
    <div
      key={session.id}
      onClick={() => setCollapsedIds(prev => {
        const next = new Set(prev)
        if (next.has(session.id)) next.delete(session.id)
        else next.add(session.id)
        return next
      })}
      className="bg-surface-1 border border-border rounded-lg px-3 py-2.5 cursor-pointer hover:border-border-bright transition-colors"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-mono font-medium text-text-primary truncate">
            {session.branch || session.name}
          </p>
          {session.toolId && (
            <span
              className="text-[9px] font-mono rounded px-1 py-0.5 shrink-0"
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
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          {sessionIndex.has(session.id) && (
            <span className="text-[10px] font-mono text-text-muted opacity-60">
              ctrl-{sessionIndex.get(session.id)}
            </span>
          )}
        {onClose && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClose(session.id)
            }}
            className="text-text-muted hover:text-red-400 text-xs shrink-0"
            title="Close session"
          >
            ✕
          </button>
        )}
        </div>
      </div>
      {showWorkspace && session.workspace && (
        <p className="text-[10px] text-text-muted truncate">
          {session.workspace.split('/').pop()}
        </p>
      )}
      {session.lastEvent && (
        <p className="text-[11px] font-mono text-text-muted truncate mt-1">
          {session.lastEvent}
        </p>
      )}
      {isExpanded && (
        <div className="mt-3 pt-3 border-t border-border">
          {session.toolId !== 'terminal' && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <span className={`h-2 w-2 rounded-full shrink-0 ${col.dotClass} ${col.key === 'working' || col.key === 'needs-input' ? 'animate-pulse' : ''}`} />
                <span className={`text-xs font-semibold ${col.color}`}>
                  {stateLabel.charAt(0).toUpperCase() + stateLabel.slice(1)}
                </span>
              </div>
              {stateSummary && (
                <p className="text-[11px] font-mono text-text-muted mb-3">
                  {stateSummary}
                </p>
              )}
            </>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onSelectAgent(session.id)
            }}
            className="w-full text-xs text-text-secondary bg-surface-0 border border-border rounded px-3 py-1.5 hover:text-text-primary hover:border-border-bright transition-colors"
          >
            {session.toolId === 'terminal' ? 'Open terminal' : 'Work with agent'}
          </button>
        </div>
      )}
    </div>
  )
}

export default function KanbanBoard({ sessions, onSelectAgent, onClose, onNewAgent, showWorkspace }) {
  const [collapsedIds, setCollapsedIds] = useState(new Set())

  const grouped = { idle: [], working: [], 'needs-input': [], terminal: [] }
  const sessionIndex = new Map()
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]
    grouped[getColumnKey(session)].push(session)
    if (i < 10) sessionIndex.set(session.id, i < 9 ? String(i + 1) : '0')
  }

  const terminalCol = { key: 'terminal', label: 'Terminals', dotClass: 'bg-surface-3', color: 'text-text-muted' }

  return (
    <div className="flex-1 min-h-0 overflow-auto p-4">
      <div className="grid grid-cols-3 gap-4 h-full">
        {COLUMNS.map(col => (
          <div key={col.key} className="flex flex-col min-h-0">
            <div className="flex items-center gap-2 mb-3 px-1">
              <span className={`h-2 w-2 rounded-full shrink-0 ${col.dotClass}`} />
              <span className={`text-xs font-semibold ${col.color}`}>{col.label}</span>
              <span className="text-[10px] text-text-muted">({grouped[col.key].length})</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
              {grouped[col.key].map(session => (
                <SessionCard
                  key={session.id}
                  session={session}
                  col={col}
                  collapsedIds={collapsedIds}
                  setCollapsedIds={setCollapsedIds}
                  sessionIndex={sessionIndex}
                  onSelectAgent={onSelectAgent}
                  onClose={onClose}
                  showWorkspace={showWorkspace}
                />
              ))}
              {col.key === 'idle' && onNewAgent && (
                <button
                  onClick={onNewAgent}
                  className="w-full text-xs text-text-muted hover:text-text-secondary border border-dashed border-border hover:border-border-bright rounded-lg px-3 py-2.5 transition-colors"
                >
                  + New Agent
                </button>
              )}
              {col.key === 'idle' && (
                <div className="mt-4">
                  <div className="flex items-center gap-2 mb-3 px-1">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${terminalCol.dotClass}`} />
                    <span className={`text-xs font-semibold ${terminalCol.color}`}>{terminalCol.label}</span>
                    <span className="text-[10px] text-text-muted">({grouped.terminal.length})</span>
                  </div>
                  <div className="space-y-2">
                    {grouped.terminal.map(session => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        col={terminalCol}
                        collapsedIds={collapsedIds}
                        setCollapsedIds={setCollapsedIds}
                        sessionIndex={sessionIndex}
                        onSelectAgent={onSelectAgent}
                        onClose={onClose}
                        showWorkspace={showWorkspace}
                      />
                    ))}
                  </div>
                </div>
              )}
              {grouped[col.key].length === 0 && col.key !== 'idle' && (
                <div className="flex items-center justify-center h-20">
                  <p className="text-[10px] text-text-muted">No agents</p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
