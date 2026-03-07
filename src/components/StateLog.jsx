import { useState, useEffect, useRef, useCallback, memo } from 'react'

const STATE_STYLES = {
  working: { color: 'text-status-running', bg: 'bg-status-running', label: 'Working', pulse: true },
  idle: { color: 'text-text-muted', bg: 'bg-status-backlog', label: 'Idle', pulse: false },
  'needs-input': { color: 'text-status-guidance', bg: 'bg-status-guidance', label: 'Needs Input', pulse: true },
  done: { color: 'text-status-merged', bg: 'bg-status-merged', label: 'Done', pulse: false },
  error: { color: 'text-red-400', bg: 'bg-red-500', label: 'Error', pulse: false },
}

const EventRow = memo(function EventRow({ entry }) {
  const [open, setOpen] = useState(false)
  const hasExpanded = entry.expanded && entry.expanded.length > 0

  return (
    <div
      className={`px-4 py-2 transition-colors ${hasExpanded ? 'cursor-pointer hover:bg-surface-1' : ''}`}
      onClick={() => hasExpanded && setOpen((o) => !o)}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm shrink-0">{entry.icon}</span>
        <span className="text-xs font-mono font-medium text-text-secondary">
          {entry.label}
        </span>
        {hasExpanded && (
          <span className={`text-[10px] text-text-muted transition-transform ${open ? 'rotate-90' : ''}`}>
            ▶
          </span>
        )}
        <span className="text-xs font-mono text-text-muted ml-auto shrink-0">
          {entry.timestamp}
        </span>
      </div>
      {!open && entry.detail && (
        <p className="text-xs font-mono text-text-muted mt-0.5 truncate pl-7">
          {entry.detail}
        </p>
      )}
      {open && (
        <pre className="text-xs font-mono text-text-secondary mt-1 pl-7 whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
          {entry.expanded}
        </pre>
      )}
    </div>
  )
})

export default function StateLog({ sessionId }) {
  const [currentState, setCurrentState] = useState({ state: 'idle', summary: 'Waiting...' })
  const [events, setEvents] = useState([])
  const scrollRef = useRef(null)
  const isNearBottomRef = useRef(true)

  const checkNearBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // "Near bottom" = within 60px of the bottom edge
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [])

  useEffect(() => {
    setCurrentState({ state: 'idle', summary: 'Waiting...' })
    setEvents([])
    isNearBottomRef.current = true

    if (!sessionId) return

    const removeStateListener = window.electronAPI.onJsonlState((sid, state) => {
      if (sid === sessionId) {
        setCurrentState(state)
      }
    })

    const removeEventListener = window.electronAPI.onJsonlEvent((sid, entry) => {
      if (sid === sessionId) {
        setEvents((prev) => [...prev, entry])
      }
    })

    return () => {
      removeStateListener()
      removeEventListener()
    }
  }, [sessionId])

  // Auto-scroll: snap to top when new events arrive (newest-first order)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [events.length])

  if (!sessionId) {
    return (
      <div className="flex flex-col h-full bg-surface-0 items-center justify-center">
        <p className="text-xs text-text-muted">No active Claude session</p>
        <p className="text-xs text-text-muted mt-1">Start Claude in the terminal to begin</p>
      </div>
    )
  }

  const style = STATE_STYLES[currentState.state] || STATE_STYLES.idle

  return (
    <div className="flex flex-col h-full bg-surface-0">
      {/* State badge */}
      <div className="border-b border-border px-4 py-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <span
            className={`h-2.5 w-2.5 rounded-full ${style.bg} ${style.pulse ? 'animate-pulse' : ''}`}
          />
          <span className={`text-sm font-semibold ${style.color}`}>
            {style.label}
          </span>
        </div>
        {currentState.summary && (
          <p className="text-xs text-text-secondary mt-1 font-mono truncate">
            {currentState.summary}
          </p>
        )}
      </div>

      {/* Event log — newest at bottom */}
      <div
        ref={scrollRef}
        onScroll={checkNearBottom}
        className="flex-1 overflow-y-auto min-h-0"
      >
        {events.length === 0 ? (
          <div className="px-4 py-6 text-xs text-text-muted text-center">
            Waiting for JSONL events...
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {[...events].reverse().map((entry, i) => (
              <EventRow key={events.length - 1 - i} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
