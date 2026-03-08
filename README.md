# Agent Manager 
<img width="128" height="128" alt="helm" src="https://github.com/user-attachments/assets/7da47a7e-e560-4936-8699-4a2ac38e1796" />
 

A desktop app for running multiple CLI coding agents in parallel. Each agent gets its own interactive terminal and isolated git worktree. A kanban board tracks what every agent is doing so you know which ones need your attention.

Currently supports [Claude Code](https://docs.anthropic.com/en/docs/claude-code). More agents planned.

**Key features:**
- Run multiple coding agents simultaneously, each in its own git worktree
- Kanban board showing all agents by state (Idle / Working / Needs Input)
- Switch between agents instantly — terminals stay alive in the background
- Works with any directory, with full worktree isolation for git repos

## Prerequisites

- A supported coding agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` command available in your terminal)
- macOS (Windows and Linux builds planned)

## Installation

### Option 1: Homebrew (recommended)

```bash
brew install --cask krishnasuraj/tap/agent-manager
```

After installation, remove the quarantine flag (required because the app is not notarized — see [Security note](#security-note)):

```bash
xattr -cr "/Applications/Agent Manager.app"
```

Then open **Agent Manager** from your Applications folder.

### Option 2: Direct download

1. Download the DMG for your Mac from the [latest release](https://github.com/krishnasuraj/agent-manager/releases/latest):
   - **Apple Silicon** (M1/M2/M3/M4): `Agent Manager-x.x.x-arm64.dmg`
   - **Intel**: `Agent Manager-x.x.x.dmg`
2. Open the DMG and drag **Agent Manager** to your Applications folder
3. On first launch, macOS will block the app. To bypass this:

   **Method A** (terminal):
   ```bash
   xattr -cr "/Applications/Agent Manager.app"
   ```
   Then open the app normally.

   **Method B** (GUI):
   1. Try to open the app — you'll see "Apple could not verify..."
   2. Click **Done** (not "Move to Trash")
   3. Go to **System Settings > Privacy & Security**
   4. Scroll down to the message: *"Agent Manager" was blocked*
   5. Click **Open Anyway**
   6. Enter your password

   You only need to do this once.

### Option 3: Build from source

```bash
git clone https://github.com/krishnasuraj/agent-manager.git
cd agent-manager
npm install
npm run rebuild    # compiles node-pty for Electron
npm run dev        # starts the app in development mode
```

## Security note

The app is ad-hoc signed but not notarized with Apple (notarization requires a $99/year Apple Developer account). The code is fully open source — you can audit it or build from source if you prefer.

## Usage

1. On first launch, select a workspace (any directory on your machine)
2. Click **+ New Agent** (or Cmd+N) to create an agent
   - For git repos: enter a branch name — the app creates an isolated git worktree
   - For non-git directories: the agent runs directly in the directory
3. The coding agent launches automatically in the terminal. Interact with it as you normally would.
4. Switch to **Board** view to see all your agents at a glance

## License

MIT
