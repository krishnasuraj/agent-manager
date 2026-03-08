import { execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'

export function worktreeCreate(repoRoot, branch) {
  const worktreeDir = path.join(repoRoot, '.worktrees')
  const worktreePath = path.join(worktreeDir, branch)
  if (fs.existsSync(worktreePath)) {
    return { worktreePath, existing: true }
  }
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10000,
  })
  return { worktreePath, existing: false }
}

export function worktreeRemove(repoRoot, branch, { force = false } = {}) {
  const worktreeDir = path.join(repoRoot, '.worktrees')
  const worktreePath = path.join(worktreeDir, branch)
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(worktreePath)
  execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10000,
  })
  try {
    execFileSync('git', ['branch', '-d', branch], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5000,
    })
  } catch {
    // Branch may have unmerged changes — leave it
  }
}

export function worktreeIsDirty(repoRoot, branch) {
  const worktreePath = path.join(repoRoot, '.worktrees', branch)
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: 5000,
    })
    return status.trim().length > 0
  } catch {
    return false
  }
}

export function worktreeListFor(repoRoot) {
  const worktreeDir = path.join(repoRoot, '.worktrees')
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5000,
    })
    const worktrees = []
    let current = {}
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current)
        current = { path: line.slice(9) }
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '')
      }
    }
    if (current.path) worktrees.push(current)
    return worktrees.filter((w) => w.path.startsWith(worktreeDir))
  } catch {
    return []
  }
}
