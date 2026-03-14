import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

export default function TerminalPanel({ sessionId, active }) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const fitAddonRef = useRef(null)
  const sessionIdRef = useRef(sessionId)

  // Keep ref in sync
  sessionIdRef.current = sessionId

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

    try { fitAddon.fit() } catch { /* */ }

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Terminal input → PTY (always uses current sessionId)
    const inputDisposable = term.onData((data) => {
      if (sessionIdRef.current) {
        window.electronAPI.ptyWrite(sessionIdRef.current, data)
      }
    })

    // Resize observer
    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        if (sessionIdRef.current) {
          window.electronAPI.ptyResize(sessionIdRef.current, term.cols, term.rows)
        }
      } catch { /* */ }
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
      try {
        fitAddonRef.current?.fit()
        if (sessionIdRef.current && termRef.current) {
          window.electronAPI.ptyResize(sessionIdRef.current, termRef.current.cols, termRef.current.rows)
        }
      } catch { /* */ }
    })
  }, [active])

  // Wire PTY data/exit listeners — reconnect when sessionId changes
  useEffect(() => {
    if (!sessionId) return

    // Send initial resize
    if (termRef.current) {
      const { cols, rows } = termRef.current
      window.electronAPI.ptyResize(sessionId, cols, rows)
    }

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
