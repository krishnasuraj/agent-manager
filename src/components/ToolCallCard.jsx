import { useState } from 'react'

const toolIcons = {
  Read: '📄',
  Write: '✏️',
  Edit: '✏️',
  Bash: '⚡',
  Glob: '🔍',
  Grep: '🔍',
  WebFetch: '🌐',
  Agent: '🤖',
}

export default function ToolCallCard({ name, input, result, status }) {
  const [expanded, setExpanded] = useState(false)
  const icon = toolIcons[name] || '🔧'

  const borderColor =
    status === 'running'
      ? 'border-l-status-running'
      : result?.isError
        ? 'border-l-red-500'
        : 'border-l-status-merged'

  const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2)

  const resultContent = result
    ? typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content, null, 2)
    : null

  return (
    <div
      className={`rounded-lg border border-border ${borderColor} border-l-2 bg-surface-1 text-xs my-1.5`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left cursor-pointer hover:bg-surface-2 rounded-lg transition-colors"
      >
        <span className="text-sm">{icon}</span>
        <span className="font-mono text-text-secondary font-medium">{name}</span>
        {status === 'running' && (
          <span className="ml-auto text-text-muted animate-pulse">running...</span>
        )}
        <svg
          className={`ml-auto w-3 h-3 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          {inputStr && (
            <div>
              <div className="text-text-muted mb-0.5">Input</div>
              <pre className="font-mono text-text-secondary bg-surface-0 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
                {inputStr}
              </pre>
            </div>
          )}
          {resultContent && (
            <div>
              <div className={`mb-0.5 ${result.isError ? 'text-red-400' : 'text-text-muted'}`}>
                {result.isError ? 'Error' : 'Result'}
              </div>
              <pre
                className={`font-mono rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all ${
                  result.isError
                    ? 'bg-red-500/10 text-red-400'
                    : 'bg-surface-0 text-text-secondary'
                }`}
              >
                {resultContent}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
