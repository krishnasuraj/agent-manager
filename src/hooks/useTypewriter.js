import { useState, useEffect, useRef, useCallback } from 'react'

const CHARS_PER_FRAME = 80

export function useTypewriter(text, active) {
  const [displayText, setDisplayText] = useState(active ? '' : text)
  const posRef = useRef(active ? 0 : text.length)
  const rafRef = useRef(null)

  const complete = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    posRef.current = text.length
    setDisplayText(text)
  }, [text])

  useEffect(() => {
    if (!active) {
      // Not animating — show full text immediately
      posRef.current = text.length
      setDisplayText(text)
      return
    }

    function tick() {
      posRef.current = Math.min(posRef.current + CHARS_PER_FRAME, text.length)
      setDisplayText(text.slice(0, posRef.current))

      if (posRef.current < text.length) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
      }
    }

    // If text grew (new content streamed in), continue from where we were
    if (posRef.current < text.length) {
      rafRef.current = requestAnimationFrame(tick)
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [text, active])

  const isTyping = active && posRef.current < text.length

  return { displayText, isTyping, complete }
}
