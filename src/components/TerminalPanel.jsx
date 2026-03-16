import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

// Minimum dimensions to prevent bogus resize during layout transitions.
// A terminal narrower than 20 cols is never useful — skip both the xterm.js
// internal resize (fitAddon.fit) AND the PTY resize to avoid permanently
// damaging Ratatui TUI scroll content with narrow-width re-renders.
const MIN_COLS = 20
const MIN_ROWS = 5
const MIN_CONTAINER_WIDTH_PX = 100
const MIN_CONTAINER_HEIGHT_PX = 50

export default function TerminalPanel({ sessionId, active }) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const fitAddonRef = useRef(null)
  const sessionIdRef = useRef(sessionId)
  const activeRef = useRef(active)
  const lastSizeRef = useRef({ cols: 0, rows: 0 })
  const [scrolledUp, setScrolledUp] = useState(false)

  // Keep refs in sync
  sessionIdRef.current = sessionId
  activeRef.current = active

  // Helper: fit xterm.js to container + resize PTY only on genuine size changes.
  // Guards against bogus small dimensions during layout transitions (e.g.
  // hidden→visible, Board→Agent view switch) that would cause Ratatui to
  // permanently re-render scroll content at a narrow width.
  // Checks buffer scroll position synchronously BEFORE fit() to decide whether
  // to snap back to bottom after — avoids all async race conditions.
  function fitAndResize() {
    const fitAddon = fitAddonRef.current
    const term = termRef.current
    const container = containerRef.current
    if (!fitAddon || !term || !container) return

    // Don't fit if container has bogus dimensions (hidden or mid-transition).
    // This prevents fitAddon.fit() from calling terminal.resize() internally
    // with a tiny viewport, which corrupts alternate-screen (Ratatui) display.
    if (container.clientWidth < MIN_CONTAINER_WIDTH_PX ||
        container.clientHeight < MIN_CONTAINER_HEIGHT_PX) return

    // Synchronous snapshot of scroll position BEFORE fit() disrupts it
    const buffer = term.buffer.active
    const wasAtBottom = buffer.viewportY >= buffer.baseY

    try {
      fitAddon.fit()
    } catch { return }

    // If user was at the bottom, snap back after fit()'s disruption.
    // If user was scrolled up reading history, leave them where reflow put them.
    if (wasAtBottom) {
      term.scrollToBottom()
    }

    const { cols, rows } = term
    if (cols < MIN_COLS || rows < MIN_ROWS) return

    const prev = lastSizeRef.current
    if (cols === prev.cols && rows === prev.rows) return

    // Hidden→visible transitions (0→real) just update the ref without sending
    // pty:resize, so full-screen TUI apps (Codex/Ratatui) don't redraw.
    const wasHidden = prev.cols === 0 || prev.rows === 0
    lastSizeRef.current = { cols, rows }

    // Only send resize to PTY on genuine size changes, not hidden→visible
    if (!wasHidden && sessionIdRef.current) {
      window.electronAPI.ptyResize(sessionIdRef.current, cols, rows)
    }
  }

  function scrollToBottom() {
    if (termRef.current) {
      termRef.current.scrollToBottom()
      setScrolledUp(false)
    }
  }

  // Create terminal once on mount
  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: '#0a0a0f',
        foreground: '#e4e4ed',
        cursor: '#e4e4ed',
        cursorAccent: '#0a0a0f',
        selectionBackground: '#3a3a5580',
        black: '#1a1a26',
        red: '#f87171',
        green: '#22c55e',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#a78bfa',
        cyan: '#22d3ee',
        white: '#e4e4ed',
        brightBlack: '#5c5c78',
        brightRed: '#fca5a5',
        brightGreen: '#4ade80',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#c4b5fd',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      },
      scrollback: 2000,
      allowProposedApi: true,
      cursorBlink: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(containerRef.current)

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Track scroll state for the "scroll to bottom" indicator.
    // term.onScroll only fires for content-driven scrolling (new output), not
    // user mouse wheel scrolling. Listen on the actual viewport DOM element
    // which fires for ALL scroll changes (user wheel, scrollbar, programmatic).
    const viewportEl = containerRef.current.querySelector('.xterm-viewport')
    const handleViewportScroll = () => {
      const buf = term.buffer.active
      setScrolledUp(buf.viewportY < buf.baseY)
    }
    if (viewportEl) {
      viewportEl.addEventListener('scroll', handleViewportScroll)
    }

    // Option+Down → scroll to bottom. Let Ctrl+digit bubble up for session switching.
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.type === 'keydown') {
        if (e.key >= '0' && e.key <= '9') return false
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.type === 'keydown') {
        if (e.key === 'ArrowDown') {
          term.scrollToBottom()
          setScrolledUp(false)
          return false
        }
      }
      return true
    })

    // Initial fit — only if container has reasonable dimensions.
    // Terminals created while hidden (e.g. second terminal) will get
    // fitted when they become active via the active useEffect.
    try {
      if (containerRef.current.clientWidth >= MIN_CONTAINER_WIDTH_PX &&
          containerRef.current.clientHeight >= MIN_CONTAINER_HEIGHT_PX) {
        fitAddon.fit()
        if (term.cols >= MIN_COLS && term.rows >= MIN_ROWS) {
          lastSizeRef.current = { cols: term.cols, rows: term.rows }
        }
      }
    } catch { /* */ }

    // Terminal input → PTY. Scroll to bottom on any user input —
    // typing means you want to see the prompt area.
    const inputDisposable = term.onData((data) => {
      if (sessionIdRef.current) {
        window.electronAPI.ptyWrite(sessionIdRef.current, data)
      }
      term.scrollToBottom()
      setScrolledUp(false)
    })

    // Resize observer — skip when hidden/inactive to avoid bogus resizes.
    // Non-active terminals get fitted when they become active (via the
    // active useEffect below), so skipping here is safe.
    const observer = new ResizeObserver(() => {
      if (!activeRef.current) return
      fitAndResize()
    })
    observer.observe(containerRef.current)

    return () => {
      if (viewportEl) {
        viewportEl.removeEventListener('scroll', handleViewportScroll)
      }
      observer.disconnect()
      inputDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  // Refit when becoming visible (CSS display change needs a paint cycle).
  // Always scroll to bottom on tab switch — switching to a terminal means
  // you want to see the latest output.
  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      fitAndResize()
      scrollToBottom()
    })
  }, [active])

  // Wire PTY data/exit listeners — reconnect when sessionId changes
  useEffect(() => {
    if (!sessionId) return

    // Send initial resize
    fitAndResize()

    const removeDataListener = window.electronAPI.onPtyData((sid, data) => {
      if (sid === sessionId && termRef.current) {
        termRef.current.write(data)
      }
    })

    const removeExitListener = window.electronAPI.onPtyExit((sid, info) => {
      if (sid === sessionId && termRef.current) {
        termRef.current.write(`\r\n\x1b[90m[Process exited with code ${info.exitCode}]\x1b[0m\r\n`)
      }
    })

    return () => {
      removeDataListener()
      removeExitListener()
    }
  }, [sessionId])

  return (
    <div className="relative w-full h-full">
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ padding: '8px 0 0 8px' }}
      />
      {scrolledUp && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5 bg-surface-2/90 border border-border text-text-muted hover:text-text-primary text-[11px] rounded px-2 py-1 transition-colors backdrop-blur-sm"
        >
          <span>&#8595;</span> Bottom <kbd className="text-[10px] text-text-muted/60 ml-0.5">&#8997;&#8595;</kbd>
        </button>
      )}
    </div>
  )
}
