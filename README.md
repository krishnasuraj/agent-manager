# Agent Navigator 
<img width="128" height="128" alt="helm" src="https://github.com/user-attachments/assets/7da47a7e-e560-4936-8699-4a2ac38e1796" />

_Read more about Agent Navigator [here](https://krishnasuraj.substack.com/p/agent-navigator-coordinate-cli-coding-agents)._

A desktop app for running multiple CLI coding agents in parallel. Each agent gets its own interactive terminal and isolated git worktree. A kanban board tracks what every agent is doing so you know which ones need your attention.

Currently supports [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [OpenAI Codex CLI](https://github.com/openai/codex). More agents planned.

**Key features:**
- Run multiple coding agents simultaneously, each in its own git worktree
- Kanban board showing all agents by state (Idle / Working / Needs Input)
- Switch between agents instantly — terminals stay alive in the background
- Works with any directory, with full worktree isolation for git repos

## Prerequisites

- At least one supported coding agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` command available in your terminal)
  - [OpenAI Codex CLI](https://github.com/openai/codex) (`codex` command available in your terminal)
- macOS (Windows and Linux builds planned)

## Install

Download the DMG for your Mac from the [latest release](https://github.com/krishnasuraj/agent-navigator/releases/latest):

- **Apple Silicon** (M1/M2/M3/M4): `agent-navigator-x.x.x-arm64.dmg`
- **Intel**: `agent-navigator-x.x.x-x64.dmg`

Open the DMG and drag **Agent Navigator** to your Applications folder.

Also available via Homebrew:

```bash
brew install --cask krishnasuraj/tap/agent-navigator
```

### Updating

Agent Navigator checks for updates automatically on launch. You can also check manually via **Agent Navigator > Check for Updates** in the menu bar.

### Build from source

```bash
git clone https://github.com/krishnasuraj/agent-navigator.git
cd agent-navigator
npm install
npm run rebuild    # compiles node-pty for Electron
npm run dev        # starts the app in development mode
```

## Usage

1. On first launch, select a workspace (any directory on your machine)
2. Click **+ New Agent** (or Cmd+N) to create an agent
   - For git repos: enter a branch name — the app creates an isolated git worktree
   - For non-git directories: the agent runs directly in the directory
3. The coding agent launches automatically in the terminal. Interact with it as you normally would.
4. Switch to **Board** view to see all your agents at a glance

## License

MIT
