import { useState, useRef, useEffect } from 'react'
import { useSession } from '../hooks/useSession'
import ToolCallCard from './ToolCallCard'

const statusDot = {
  idle: 'bg-status-backlog',
  'in-progress': 'bg-status-running animate-glow',
  'input-required': 'bg-status-guidance animate-glow',
  completed: 'bg-status-merged',
}

export default function SessionPanel({ task, onClose }) {
  const { messages, isStreaming, pendingQuestion, sendMessage, abort } = useSession(task?.id)
  const [inputText, setInputText] = useState('')
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isStreaming, pendingQuestion])

  if (!task) return null

  const dot = statusDot[task.status] || 'bg-status-backlog'

  function handleSend() {
    if (!inputText.trim() || isStreaming) return
    sendMessage(inputText)
    setInputText('')
    textareaRef.current?.focus()
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleOptionClick(option) {
    sendMessage(option.label)
  }

  return (
    <div className="flex flex-col h-full bg-surface-0 border-l border-border">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`h-2 w-2 rounded-full shrink-0 ${dot}`} />
          <span className="text-sm font-medium text-text-primary truncate">{task.title}</span>
          <span className="font-mono text-xs text-text-muted shrink-0">{task.branch}</span>
        </div>
        <div className="flex items-center gap-2 ml-3 shrink-0">
          {isStreaming && (
            <button
              onClick={abort}
              className="rounded-md px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer"
            >
              Stop
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors cursor-pointer"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}

        {/* Pending question from AskUserQuestion */}
        {pendingQuestion && (
          <QuestionCard
            questions={pendingQuestion.questions}
            onOptionClick={handleOptionClick}
          />
        )}

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-status-running animate-pulse" />
            Working...
          </div>
        )}

        {/* Error display */}
        {task.error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400 font-mono">
            {task.error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <div className="border-t border-border px-4 py-3 shrink-0">
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              task.status === 'completed'
                ? 'Session ended'
                : isStreaming
                  ? 'Waiting for response...'
                  : pendingQuestion
                    ? 'Pick an option above or type a custom answer...'
                    : 'Send a message...'
            }
            disabled={task.status === 'completed'}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-border-bright transition-colors disabled:opacity-40 font-mono"
          />
          <button
            onClick={handleSend}
            disabled={!inputText.trim() || isStreaming || task.status === 'completed'}
            className="shrink-0 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-text-primary hover:bg-white/15 transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

function QuestionCard({ questions, onOptionClick }) {
  return (
    <div className="space-y-3">
      {questions.map((q, qi) => (
        <div key={qi} className="rounded-lg border border-status-guidance/30 bg-status-guidance/5 p-3">
          <div className="text-sm font-medium text-text-primary mb-2">{q.question}</div>
          <div className="space-y-1.5">
            {q.options?.map((opt, oi) => (
              <button
                key={oi}
                onClick={() => onOptionClick(opt)}
                className="w-full text-left rounded-lg border border-border bg-surface-1 px-3 py-2 hover:bg-surface-2 hover:border-border-bright transition-colors cursor-pointer"
              >
                <div className="text-sm font-medium text-text-primary">{opt.label}</div>
                {opt.description && (
                  <div className="text-xs text-text-secondary mt-0.5">{opt.description}</div>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function MessageBubble({ message }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text-primary max-w-[80%] whitespace-pre-wrap font-mono">
          {message.content}
        </div>
      </div>
    )
  }

  if (message.role === 'assistant') {
    return (
      <div className="space-y-1.5">
        {message.content && (
          <div className="text-sm text-text-primary whitespace-pre-wrap font-mono leading-relaxed">
            {message.content}
          </div>
        )}
        {message.toolCalls?.map((tc, i) => (
          <ToolCallCard key={i} name={tc.name} input={tc.input} status="done" />
        ))}
      </div>
    )
  }

  if (message.role === 'tool_result') {
    return (
      <div className="space-y-1.5">
        {message.toolResults?.map((tr, i) => (
          <div
            key={i}
            className={`rounded-lg border px-3 py-2 text-xs font-mono max-h-32 overflow-y-auto whitespace-pre-wrap break-all ${
              tr.isError
                ? 'border-red-500/30 bg-red-500/10 text-red-400'
                : 'border-border bg-surface-1 text-text-secondary'
            }`}
          >
            {typeof tr.content === 'string'
              ? tr.content
              : JSON.stringify(tr.content, null, 2)}
          </div>
        ))}
      </div>
    )
  }

  return null
}
