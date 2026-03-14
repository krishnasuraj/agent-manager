import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

export default function TerminalPanel({ sessionId, active }) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const fitAddonRef = useRef(null)
  const sessionIdRef = useRef(sessionId)
  const activeRef = useRef(active)
  const lastSizeRef = useRef({ cols: 0, rows: 0 })

  // Keep refs in sync
  sessionIdRef.current = sessionId
  activeRef.current = active

  // Helper: fit xterm.js to container + resize PTY only on genuine size changes.
  // "Genuine" = both old and new sizes are non-zero (actual window resize).
  // Hidden→visible transitions (0→real) just update the ref without sending
  // pty:resize, so full-screen TUI apps (Codex/Ratatui) don't redraw.
  function fitAndResize() {
    const fitAddon = fitAddonRef.current
    const term = termRef.current
    if (!fitAddon || !term) return

    try {
      fitAddon.fit()
    } catch { return }

    const { cols, rows } = term
    if (cols <= 0 || rows <= 0) return

    const prev = lastSizeRef.current
    if (cols === prev.cols && rows === prev.rows) return

    const wasHidden = prev.cols === 0 || prev.rows === 0
    lastSizeRef.current = { cols, rows }

    // Only send resize to PTY on genuine size changes, not hidden→visible
    if (!wasHidden && sessionIdRef.current) {
      window.electronAPI.ptyResize(sessionIdRef.current, cols, rows)
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

    // Initial fit
    try {
      fitAddon.fit()
      lastSizeRef.current = { cols: term.cols, rows: term.rows }
    } catch { /* */ }

    // Terminal input → PTY (always uses current sessionId)
    const inputDisposable = term.onData((data) => {
      if (sessionIdRef.current) {
        window.electronAPI.ptyWrite(sessionIdRef.current, data)
      }
    })

    // Resize observer — skip when hidden to avoid bogus 0-size resizes
    const observer = new ResizeObserver(() => {
      fitAndResize()
    })
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      inputDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  // Refit when becoming visible (CSS display change needs a paint cycle)
  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      fitAndResize()
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
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ padding: '8px 0 0 8px' }}
    />
  )
}
