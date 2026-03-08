import { execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'

/**
 * Resolve the true git repo root. If cwd is inside a worktree,
 * `git rev-parse --show-toplevel` returns the worktree path, but the
 * `.git` file inside it points to the real repo's `.git/worktrees/` dir.
 * We need the real repo root so worktrees are always created at the top level.
 */
function resolveRepoRoot(dirPath) {
  try {
    const gitPath = path.join(dirPath, '.git')
    const stat = fs.statSync(gitPath)
    if (stat.isFile()) {
      // This is a worktree — .git is a file like "gitdir: /real/repo/.git/worktrees/branch"
      const content = fs.readFileSync(gitPath, 'utf8').trim()
      const match = content.match(/^gitdir:\s*(.+)$/)
      if (match) {
        // Follow the gitdir path up to the real repo root
        // e.g. /real/repo/.git/worktrees/branch → /real/repo
        const gitdir = path.resolve(dirPath, match[1])
        const realGitDir = path.resolve(gitdir, '..', '..')
        if (path.basename(realGitDir) === '.git') {
          return path.dirname(realGitDir)
        }
      }
    }
  } catch { /* not a worktree or .git doesn't exist */ }
  return dirPath
}

export function worktreeCreate(repoRoot, branch) {
  repoRoot = resolveRepoRoot(repoRoot)
  const worktreeDir = path.join(repoRoot, '.worktrees')
  const worktreePath = path.join(worktreeDir, branch)
  if (fs.existsSync(worktreePath)) {
    return { worktreePath, existing: true }
  }
  // Try creating with a new branch first; if the branch already exists, check it out instead
  try {
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', branch], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10000,
    })
  } catch {
    execFileSync('git', ['worktree', 'add', worktreePath, branch], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10000,
    })
  }
  // Symlink node_modules from the main repo so the worktree can run immediately
  const srcModules = path.join(repoRoot, 'node_modules')
  const destModules = path.join(worktreePath, 'node_modules')
  if (fs.existsSync(srcModules) && !fs.existsSync(destModules)) {
    fs.symlinkSync(srcModules, destModules, 'dir')
  }
  return { worktreePath, existing: false }
}

export function worktreeRemove(repoRoot, branch, { force = false } = {}) {
  repoRoot = resolveRepoRoot(repoRoot)
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
  repoRoot = resolveRepoRoot(repoRoot)
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
  repoRoot = resolveRepoRoot(repoRoot)
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
