import { useState, useEffect, useCallback } from 'react'

export function useSession(taskId) {
  const [messages, setMessages] = useState([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [pendingQuestion, setPendingQuestion] = useState(null) // { questions, toolUseId }
  const [toolResultMap, setToolResultMap] = useState({}) // keyed by toolUseId

  useEffect(() => {
    if (!taskId) return

    setMessages([])
    setIsStreaming(false)
    setPendingQuestion(null)
    setToolResultMap({})

    const removeListener = window.electronAPI.onSessionEvent(taskId, (event) => {
      switch (event.type) {
        case 'assistant_message': {
          setMessages((prev) => [...prev, event.message])
          setIsStreaming(event.message.toolCalls?.length > 0)
          break
        }

        case 'tool_result': {
          // Store results in map keyed by toolUseId instead of appending to messages
          if (event.results) {
            setToolResultMap((prev) => {
              const next = { ...prev }
              for (const tr of event.results) {
                next[tr.toolUseId] = { content: tr.content, isError: tr.isError }
              }
              return next
            })
          }
          setIsStreaming(true)
          break
        }

        case 'ask_user_question': {
          setPendingQuestion({ questions: event.questions, toolUseId: event.toolUseId })
          setIsStreaming(false)
          break
        }

        case 'session_end': {
          setIsStreaming(false)
          setPendingQuestion(null)
          break
        }

        case 'error': {
          setIsStreaming(false)
          break
        }

        default:
          break
      }
    })

    return () => removeListener()
  }, [taskId])

  const sendMessage = useCallback(
    (text) => {
      if (!taskId || !text.trim()) return
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: text.trim(), timestamp: Date.now() },
      ])
      setIsStreaming(true)
      setPendingQuestion(null)
      return window.electronAPI.sendMessage(taskId, text.trim())
    },
    [taskId],
  )

  const abort = useCallback(() => {
    if (!taskId) return
    window.electronAPI.abortSession(taskId)
    setIsStreaming(false)
  }, [taskId])

  return {
    messages,
    isStreaming,
    pendingQuestion,
    toolResultMap,
    sendMessage,
    abort,
  }
}
