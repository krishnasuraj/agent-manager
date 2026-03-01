// Seed tasks for testing. Auto-creates and starts tasks when --seed flag is passed.

const SEED_TASKS = [
  {
    title: 'Hello world HTML',
    prompt:
      'Create a file called hello.html with a basic HTML page that says "Hello World" in large centered text on a dark background. Do not ask any questions, just do it.',
  },
  {
    title: 'Fibonacci module',
    prompt:
      'Create a file called fib.js that exports a function to compute the nth Fibonacci number using memoization. Then create fib.test.js with at least 5 test cases. Then read both files back and confirm they look correct.',
  },
  {
    title: 'CLI tool chooser',
    prompt:
      'I want to build a small CLI tool. Before writing any code, ask me what language I want to use and what the tool should do. Present me with a few options using AskUserQuestion.',
  },
]

export function seedTasks(taskStore, claudeManager, getWindow) {
  console.log(`[seed] Creating ${SEED_TASKS.length} test tasks...`)

  for (const { title, prompt } of SEED_TASKS) {
    const task = taskStore.create({ title, baseBranch: 'main' })

    try {
      claudeManager.startSession(task.id)
      claudeManager.sendMessage(task.id, prompt)
      console.log(`[seed] Started: "${title}" (${task.id})`)
    } catch (err) {
      console.error(`[seed] Failed to start "${title}":`, err.message)
    }
  }
}
