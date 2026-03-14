import { useState, useEffect, useRef, useCallback } from 'react'
import TerminalPanel from './components/TerminalPanel'
import StateLog from './components/StateLog'
import SessionList from './components/SessionList'
import ResizableSplit from './components/ResizableSplit'
import KanbanBoard from './components/KanbanBoard'

export default function App() {
  const [sessions, setSessions] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [showNewAgent, setShowNewAgent] = useState(false)
  const [view, setView] = useState('board') // 'board' | 'agent'
  const [branchInput, setBranchInput] = useState('')
  const [workspaces, setWorkspaces] = useState([])
  const [selectedWorkspace, setSelectedWorkspace] = useState(null)
  const [availableTools, setAvailableTools] = useState([])
  const [selectedTool, setSelectedTool] = useState('claude')
  const spawned = useRef(false)
  const workspacesRef = useRef(workspaces)

  const spawnAgent = useCallback(async (branch, workspace, cwd, toolId = 'claude') => {
    const id = `session-${Date.now()}`
    setSessions(prev => [...prev, {
      id, name: branch, branch, workspace, toolId, claudeActive: false, state: null, lastEvent: null,
    }])
    setActiveSessionId(id)
    setView('agent')
    try {
      await window.electronAPI.spawnSession(id, { cwd, toolId })
    } catch (err) {
      console.error('Failed to spawn session:', err)
    }
  }, [])

  // Fetch workspaces and auto-spawn on mount
  useEffect(() => {
    if (spawned.current) return
    spawned.current = true

    window.electronAPI.getAvailableTools().then(tools => {
      if (tools?.length > 0) setAvailableTools(tools)
    })

    const wsPromise = window.electronAPI.getWorkspaces().then(ws => {
      setWorkspaces(ws)
      if (ws.length > 0) {
        setSelectedWorkspace(ws[0].path)
      }
      return ws
    })

    const TEST_PROMPTS = [
      'write a haiku about the ocean and save it to haiku.txt',
      'write a limerick about coding and save it to limerick.txt',
      'write a sonnet about the moon and save it to sonnet.txt',
      'list the files in this directory and describe what you see',
      'write a short joke about recursion and save it to joke.txt',
    ]

    window.electronAPI.getTestConfig().then(({ testSessions, testCwds, testBranches }) => {
      if (testSessions > 0) {
        for (let i = 0; i < testSessions; i++) {
          const prompt = TEST_PROMPTS[i % TEST_PROMPTS.length]
          setTimeout(() => {
            const id = `session-${Date.now()}`
            const branch = testBranches[i]
            setSessions(prev => [...prev, {
              id, name: branch, branch, workspace: null, claudeActive: false, state: null, lastEvent: null,
            }])
            setActiveSessionId(id)
            window.electronAPI.spawnSession(id, { cwd: testCwds[i], initialPrompt: prompt })
          }, i * 2000)
        }
      } else {
        wsPromise.then(ws => {
          if (ws.length > 0) setShowNewAgent(true)
        })
      }
    })
  }, [])

  // Listen for workspace changes from main process
  useEffect(() => {
    const remove = window.electronAPI.onWorkspacesChanged((ws) => {
      setWorkspaces(ws)
      setSelectedWorkspace(prev => {
        if (prev && ws.some(w => w.path === prev)) return prev
        return ws.length > 0 ? ws[0].path : null
      })
    })
    return () => remove()
  }, [])

  // Keep workspacesRef in sync
  useEffect(() => { workspacesRef.current = workspaces }, [workspaces])

  // Listen for menu events (Cmd+N from native menu, Cmd+1/2 for view switching)
  useEffect(() => {
    const removeNewAgent = window.electronAPI.onMenuNewAgent(() => {
      if (workspacesRef.current.length > 0) {
        setShowNewAgent(true)
      }
    })
    const removeView = window.electronAPI.onMenuView((v) => setView(v))
    return () => { removeNewAgent(); removeView() }
  }, [])

  // Global IPC listeners
  useEffect(() => {
    const removeStarted = window.electronAPI.onJsonlSessionStarted((id) => {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, claudeActive: true } : s))
    })
    const removeEnded = window.electronAPI.onJsonlSessionEnded((id) => {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, claudeActive: false, state: null } : s))
    })
    const removeState = window.electronAPI.onJsonlState((id, state) => {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, state } : s))
    })
    const removeEvent = window.electronAPI.onJsonlEvent((id, entry) => {
      setSessions(prev => prev.map(s => s.id === id ? { ...s, lastEvent: entry.label } : s))
    })
    return () => {
      removeStarted()
      removeEnded()
      removeState()
      removeEvent()
    }
  }, [])

  const removeSession = (sessionId) => {
    setSessions(prev => {
      const remaining = prev.filter(s => s.id !== sessionId)
      if (activeSessionId === sessionId) {
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null)
      }
      return remaining
    })
  }

  const openNewAgentModal = () => {
    if (workspaces.length === 0) return
    if (!selectedWorkspace && workspaces.length > 0) {
      setSelectedWorkspace(workspaces[0].path)
    }
    setShowNewAgent(true)
  }

  const selectedWs = workspaces.find(w => w.path === selectedWorkspace)

  const handleNewAgent = async () => {
    const branch = branchInput.trim()
    if (!selectedWorkspace) return

    if (selectedWs?.isGit) {
      if (!branch) return
      if (!/^[\w][\w./-]*$/.test(branch)) {
        alert('Invalid branch name. Use letters, numbers, hyphens, dots, or slashes.')
        return
      }

      setShowNewAgent(false)
      setBranchInput('')

      try {
        const { worktreePath } = await window.electronAPI.worktreeCreate(selectedWorkspace, branch)
        await spawnAgent(branch, selectedWorkspace, worktreePath, selectedTool)
      } catch (err) {
        console.error('Failed to create agent:', err)
        alert(`Failed to create agent: ${err.message}`)
      }
    } else {
      // Non-git workspace — spawn directly
      const name = branch || selectedWs?.name || 'agent'
      setShowNewAgent(false)
      setBranchInput('')
      await spawnAgent(name, selectedWorkspace, selectedWorkspace, selectedTool)
    }
  }

  const addWorkspaceViaDialog = async () => {
    const ws = await window.electronAPI.addWorkspaceViaDialog()
    if (ws) {
      setWorkspaces(prev => {
        if (prev.some(w => w.path === ws.path)) return prev
        return [...prev, ws]
      })
      setSelectedWorkspace(ws.path)
    }
    return ws
  }

  const handleAddWorkspace = async () => {
    const ws = await addWorkspaceViaDialog()
    if (ws) setShowNewAgent(true)
  }

  const handleSelectAgent = (sessionId) => {
    setActiveSessionId(sessionId)
    setView('agent')
  }

  const [memoryInfo, setMemoryInfo] = useState(null) // { totalKB, mainKB, rendererKB } | null

  useEffect(() => {
    const remove = window.electronAPI.onDebugMemory((data) => setMemoryInfo(data))
    return () => remove()
  }, [])

  const [closeModal, setCloseModal] = useState(null) // { sessionId, session, dirty }

  const handleCloseSession = async (sessionId) => {
    const session = sessions.find(s => s.id === sessionId)
    if (!session) return

    if (session.branch && session.workspace) {
      let dirty = false
      try {
        const result = await window.electronAPI.worktreeIsDirty(session.workspace, session.branch)
        dirty = result.dirty
      } catch {}
      setCloseModal({ sessionId, session, dirty })
    } else {
      if (!confirm('Close this session?')) return
      await doEndSession(sessionId)
    }
  }

  const doEndSession = async (sessionId) => {
    try {
      await window.electronAPI.killSession(sessionId)
    } catch (err) {
      console.error('Failed to kill session:', err)
    }
    removeSession(sessionId)
  }

  const doEndSessionAndRemoveWorktree = async (sessionId, workspace, branch, dirty) => {
    if (dirty) {
      if (!confirm(`Branch "${branch}" has uncommitted changes.\n\nRemove worktree anyway?`)) return
    }
    try {
      await window.electronAPI.killSession(sessionId)
      // Small delay to let PTY process release the directory
      await new Promise(r => setTimeout(r, 500))
      await window.electronAPI.worktreeRemove(workspace, branch, dirty)
    } catch (err) {
      console.error('Failed to remove worktree:', err)
    }
    removeSession(sessionId)
  }

  const sidebar = (
    <div className="flex flex-col h-full min-h-0">
      <SessionList
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
        onClose={handleCloseSession}
        showWorkspace={workspaces.length > 1}
      />
      <div className="flex-1 min-h-0 relative">
        {sessions.map(session => (
          <div
            key={session.id}
            className={`absolute inset-0 ${session.id === activeSessionId ? 'flex flex-col' : 'hidden'}`}
          >
            <StateLog sessionId={session.claudeActive ? session.id : null} />
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-text-muted">Create an agent to get started</p>
          </div>
        )}
      </div>
    </div>
  )

  const terminals = (
    <div className="relative h-full">
      {sessions.map(session => (
        <div
          key={session.id}
          className={`absolute inset-0 ${session.id === activeSessionId ? 'block' : 'hidden'}`}
        >
          <TerminalPanel sessionId={session.id} active={session.id === activeSessionId} />
        </div>
      ))}
    </div>
  )

  const hasWorkspaces = workspaces.length > 0
  const showWelcome = !hasWorkspaces && sessions.length === 0

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-surface-0">
      <div
        className="flex items-center justify-between border-b border-border px-4 py-2 shrink-0"
        style={{ WebkitAppRegion: 'drag' }}
      >
        <div className="flex items-center gap-3 pl-16">
          <span className="text-xs font-medium text-text-secondary">Agent Manager</span>
          {hasWorkspaces && (
            <div className="flex border border-border rounded overflow-hidden" style={{ WebkitAppRegion: 'no-drag' }}>
              <button
                onClick={() => setView('board')}
                className={`text-[11px] px-2.5 py-1 transition-colors ${view === 'board' ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
              >
                Board <span className="text-text-muted ml-1 opacity-60">⌘1</span>
              </button>
              <button
                onClick={() => setView('agent')}
                className={`text-[11px] px-2.5 py-1 transition-colors ${view === 'agent' ? 'bg-surface-2 text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
              >
                Agent <span className="text-text-muted ml-1 opacity-60">⌘2</span>
              </button>
            </div>
          )}
        </div>
        {hasWorkspaces && (
          <div style={{ WebkitAppRegion: 'no-drag' }}>
            <button
              onClick={openNewAgentModal}
              className="text-xs text-text-muted hover:text-text-primary border border-border hover:border-border-bright rounded px-2 py-1 transition-colors"
            >
              + New Agent <span className="text-text-muted ml-1 opacity-60">⌘N</span>
            </button>
          </div>
        )}
      </div>

      {showWelcome && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-sm font-semibold text-text-primary mb-2">Welcome to Agent Manager</h2>
            <p className="text-xs text-text-muted mb-6">Select a git repository to get started.</p>
            <button
              onClick={handleAddWorkspace}
              className="text-xs bg-status-running text-white rounded px-4 py-2 hover:opacity-90 transition-opacity"
            >
              Open Workspace
            </button>
          </div>
        </div>
      )}

      <div className={`flex-1 min-h-0 ${view === 'agent' && !showWelcome ? 'flex' : 'hidden'}`}>
        <ResizableSplit
          left={sidebar}
          right={terminals}
          defaultRatio={0.3}
          minLeftPx={250}
          minRightPx={400}
        />
      </div>
      <div className={`flex-1 min-h-0 ${view === 'board' && !showWelcome ? 'flex' : 'hidden'}`}>
        <KanbanBoard
          sessions={sessions}
          onSelectAgent={handleSelectAgent}
          onClose={handleCloseSession}
          onNewAgent={openNewAgentModal}
          showWorkspace={workspaces.length > 1}
        />
      </div>

      {closeModal && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setCloseModal(null)}
        >
          <div
            className="bg-surface-1 border border-border rounded-lg p-6 w-96 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-text-primary mb-2">
              Close &quot;{closeModal.session.branch}&quot;
            </h2>
            {closeModal.dirty && (
              <p className="text-xs text-status-guidance mb-4">
                This branch has uncommitted changes.
              </p>
            )}
            <div className="flex flex-col gap-2 mt-4">
              <button
                onClick={() => {
                  const { sessionId } = closeModal
                  setCloseModal(null)
                  doEndSession(sessionId)
                }}
                className="w-full text-xs text-left bg-surface-0 hover:bg-surface-2 text-text-primary border border-border rounded px-3 py-2.5 transition-colors"
              >
                <span className="font-medium">End session</span>
                <span className="text-text-muted block mt-0.5">Kill the agent and close the terminal. Worktree stays on disk.</span>
              </button>
              <button
                onClick={() => {
                  const { sessionId, session, dirty } = closeModal
                  setCloseModal(null)
                  doEndSessionAndRemoveWorktree(sessionId, session.workspace, session.branch, dirty)
                }}
                className="w-full text-xs text-left bg-surface-0 hover:bg-surface-2 text-text-primary border border-border rounded px-3 py-2.5 transition-colors"
              >
                <span className="font-medium">End session + remove worktree</span>
                <span className="text-text-muted block mt-0.5">Kill the agent, close the terminal, and delete the worktree directory.</span>
              </button>
              <button
                onClick={() => setCloseModal(null)}
                className="w-full text-xs text-text-muted hover:text-text-primary px-3 py-1.5 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {memoryInfo && (
        <div className="fixed bottom-2 right-2 z-50 bg-surface-1/90 border border-border rounded px-2.5 py-1.5 font-mono text-[11px] text-text-muted pointer-events-none">
          RAM: {Math.round(memoryInfo.totalKB / 1024)} MB
          <span className="text-text-muted/60 ml-1.5">
            (electron {Math.round(memoryInfo.electronKB / 1024)} / agents {Math.round(memoryInfo.agentsKB / 1024)})
          </span>
        </div>
      )}

      {showNewAgent && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowNewAgent(false)}
        >
          <div
            className="bg-surface-1 border border-border rounded-lg p-6 w-80 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-text-primary mb-4">New Agent</h2>
            <form onSubmit={(e) => { e.preventDefault(); handleNewAgent() }}>
              <label className="text-xs text-text-secondary block mb-1.5">Workspace</label>
              <select
                value={selectedWorkspace || ''}
                onChange={async (e) => {
                  if (e.target.value === '__add__') {
                    e.target.value = selectedWorkspace || ''
                    await addWorkspaceViaDialog()
                  } else {
                    setSelectedWorkspace(e.target.value)
                  }
                }}
                className="w-full text-xs font-mono bg-surface-0 text-text-primary border border-border rounded px-3 py-2 outline-none focus:border-status-running mb-4"
              >
                {workspaces.map(ws => (
                  <option key={ws.path} value={ws.path}>{ws.name}</option>
                ))}
                <option value="__add__">+ Add workspace…</option>
              </select>
              {availableTools.length > 1 && (
                <>
                  <label className="text-xs text-text-secondary block mb-1.5">Tool</label>
                  <div className="flex gap-1.5 mb-4">
                    {availableTools.map(tool => (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => setSelectedTool(tool.id)}
                        className={`text-xs font-mono px-3 py-1.5 rounded border transition-colors ${
                          selectedTool === tool.id
                            ? 'bg-surface-2 border-border-bright text-text-primary'
                            : 'bg-surface-0 border-border text-text-muted hover:text-text-secondary'
                        }`}
                      >
                        {tool.displayName}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {selectedWs?.isGit ? (
                <>
                  <label className="text-xs text-text-secondary block mb-1.5">Agent name</label>
                  <input
                    autoFocus
                    value={branchInput}
                    onChange={(e) => setBranchInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && setShowNewAgent(false)}
                    placeholder="feat-my-feature"
                    className="w-full text-xs font-mono bg-surface-0 text-text-primary border border-border rounded px-3 py-2 outline-none focus:border-status-running"
                  />
                </>
              ) : (
                <>
                  <p className="text-[11px] text-status-guidance mb-3">
                    Not a git repository. Worktree isolation is unavailable — the agent will run directly in this directory.
                  </p>
                  <label className="text-xs text-text-secondary block mb-1.5">Agent name (optional)</label>
                  <input
                    autoFocus
                    value={branchInput}
                    onChange={(e) => setBranchInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && setShowNewAgent(false)}
                    placeholder={selectedWs?.name || 'my-agent'}
                    className="w-full text-xs font-mono bg-surface-0 text-text-primary border border-border rounded px-3 py-2 outline-none focus:border-status-running"
                  />
                </>
              )}
              <div className="flex justify-end gap-2 mt-5">
                <button
                  type="button"
                  onClick={() => setShowNewAgent(false)}
                  className="text-xs text-text-muted hover:text-text-primary px-3 py-1.5 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={selectedWs?.isGit ? (!branchInput.trim() || !selectedWorkspace) : !selectedWorkspace}
                  className="text-xs bg-status-running text-white rounded px-3 py-1.5 hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
