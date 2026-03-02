import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

export default function TerminalPanel({ sessionId }) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const fitAddonRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current || !sessionId) return

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
      allowProposedApi: true,
      cursorBlink: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(containerRef.current)

    // Fit to container
    try {
      fitAddon.fit()
    } catch {
      // Container might not be visible yet
    }

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Send initial resize to main process
    const { cols, rows } = term
    window.electronAPI.ptyResize(sessionId, cols, rows)

    // Terminal input → PTY
    const inputDisposable = term.onData((data) => {
      window.electronAPI.ptyWrite(sessionId, data)
    })

    // PTY output → terminal
    const removeDataListener = window.electronAPI.onPtyData((sid, data) => {
      if (sid === sessionId) {
        term.write(data)
      }
    })

    // Handle PTY exit
    const removeExitListener = window.electronAPI.onPtyExit((sid, info) => {
      if (sid === sessionId) {
        term.write(`\r\n\x1b[90m[Process exited with code ${info.exitCode}]\x1b[0m\r\n`)
      }
    })

    // Resize observer
    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        window.electronAPI.ptyResize(sessionId, term.cols, term.rows)
      } catch {
        // ignore
      }
    })
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      inputDisposable.dispose()
      removeDataListener()
      removeExitListener()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
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
