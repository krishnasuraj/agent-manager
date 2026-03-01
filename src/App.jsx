import { useState } from 'react'
import TopBar from './components/TopBar'
import BoardView from './components/BoardView'
import QueueView from './components/QueueView'
import TaskModal from './components/TaskModal'
import SessionPanel from './components/SessionPanel'
import ResizableSplit from './components/ResizableSplit'
import { useTasks } from './hooks/useTasks'

export default function App() {
  const { tasks, createTask, deleteTask, inputRequiredCount } = useTasks()
  const [view, setView] = useState('board')
  const [modalOpen, setModalOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState(null)

  const selectedTask = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId)
    : null

  const mainContent = (
    <div className="flex flex-col flex-1 min-h-0 overflow-auto pt-4">
      {view === 'board' ? (
        <BoardView tasks={tasks} onSelectTask={setSelectedTaskId} selectedTaskId={selectedTaskId} />
      ) : (
        <QueueView tasks={tasks} onSelectTask={setSelectedTaskId} selectedTaskId={selectedTaskId} />
      )}
    </div>
  )

  const sessionContent = selectedTask ? (
    <SessionPanel task={selectedTask} onClose={() => setSelectedTaskId(null)} />
  ) : (
    <div className="flex flex-1 items-center justify-center bg-surface-0">
      <p className="text-xs text-text-muted font-mono">select a task to open its session</p>
    </div>
  )

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <TopBar
        view={view}
        onViewChange={setView}
        inputRequiredCount={inputRequiredCount}
        onNewTask={() => setModalOpen(true)}
      />

      <ResizableSplit
        left={mainContent}
        right={sessionContent}
        defaultRatio={0.55}
        minLeftPx={380}
        minRightPx={300}
      />

      {modalOpen && (
        <TaskModal onClose={() => setModalOpen(false)} onCreateTask={createTask} />
      )}
    </div>
  )
}
