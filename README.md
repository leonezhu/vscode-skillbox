# SkillBox 📦

A VSCode extension for managing Agent Skills from subscription sources.

## Features

- 📥 **Subscribe to skill repositories** - GitHub URLs or local paths
- 🔄 **Sync and update skills** - Keep your skills up to date
- 📦 **Install skills easily** - One-click installation to your project
- ⚙️ **Multi-agent support** - Copilot, OpenCode, Claude, Cursor

## Supported Resource Types

| Type | Description | Install Location (Copilot) |
|------|-------------|---------------------------|
| **Skills** | Skill directories with SKILL.md | `.github/skills/{name}/` |
| **Instructions** | Instruction files (.instructions.md) | `.github/instructions/{name}.instructions.md` |
| **Agents** | Agent definitions (.agent.md) | `.github/agents/{name}.agent.md` |
| **Special Files** | copilot-instructions.md, AGENT.md, CLAUDE.md | Project root |

## Usage

### 1. Add a Subscription Source

Click the **+** icon in the SkillBox panel and enter:
- GitHub URL: `https://github.com/owner/repo`
- Git SSH: `git@github.com:owner/repo.git`
- Local path: `/path/to/local/repo`

### 2. Browse and Install

1. Expand a source to see available resources
2. Right-click a resource → **Install**
3. Resources are installed to the appropriate location

### 3. Manage Sources

Right-click a source to:
- **Sync** - Update from remote
- **Open** - Open in browser (GitHub) or file manager (local)
- **Remove** - Remove from subscriptions

## Configuration

Open settings with the **⚙️** icon or search "skillbox" in VSCode settings.

| Setting | Options | Description |
|---------|---------|-------------|
| `centralRepo` | Path | Central storage for synced skills (default: `~/.skillbox`) |
| `defaultAgent` | copilot, opencode, claude, cursor | Target agent for skill installation |
| `defaultScope` | project, global | Install to workspace or user home |
| `installMethod` | copy, symlink | Copy files or create symbolic links |

## Installation Paths

### Copilot
- Skills: `.github/skills/{name}/`
- Instructions: `.github/instructions/{name}.instructions.md`
- Agents: `.github/agents/{name}.agent.md`

### OpenCode
- Skills: `.agents/skills/{name}/`

### Claude
- Skills: `.claude/skills/{name}/`

### Cursor
- Skills: `.cursor/skills/{name}/`

## Example: awesome-copilot

```bash
# Add the official Copilot skills repository
https://github.com/github/awesome-copilot
```

This repository contains:
- 250+ Skills
- 170+ Instructions
- 180+ Agents
- Special files (copilot-instructions.md, AGENT.md)

## Development

```bash
# Install dependencies
yarn install

# Compile
yarn compile

# Watch for changes
yarn watch

# Package extension
vsce package
```

## License

MIT
