# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
yarn install          # Install dependencies
yarn compile          # Compile TypeScript to out/
yarn watch            # Watch mode for development
yarn lint             # Run ESLint
vsce package          # Package extension to .vsix
```

## Architecture Overview

This is a VSCode extension for managing Agent Skills from subscription sources (GitHub repos or local paths).

### Core Components

**extension.ts** - Entry point that:
- Initializes SourceManager, SkillInstaller, and SkillBoxProvider
- Registers the tree view in the SkillBox activity bar panel
- Registers all commands (addSource, syncSource, installSkill, etc.)

**SourceManager** (`managers/sourceManager.ts`) - Handles:
- Source subscriptions (GitHub URLs or local paths)
- Syncing sources via git clone/pull to a cache directory
- Scanning sources for skills (SKILL.md), instructions (.instructions.md), agents (.agent.md), and special files

**SkillInstaller** (`services/installer.ts`) - Manages:
- Installing skills to project or global scope
- Copy vs symlink installation methods
- Tracking installed skills with commit hashes for update detection
- Uninstallation and updates

**SkillBoxProvider** (`providers/skillboxProvider.ts`) - Tree data provider:
- Renders the sidebar tree with sources and their resources
- Shows install status (installed, update available)
- Background sync every 5 minutes

**types/index.ts** - Type definitions:
- `AGENT_PATHS`: Maps agent types to their install directories (e.g., `github-copilot` → `.agents/skills`, `claude-code` → `.claude/skills`)
- `Source`, `Skill`, `InstallRecord` interfaces

### Data Flow

1. User adds a source URL → SourceManager clones to `~/.skillbox/.cache/{source-name}`
2. SourceManager scans for resources and stores metadata in VSCode's globalState
3. User clicks Install → SkillInstaller copies/symlinks to the appropriate directory based on agent type
4. InstallRecord is saved with commit hash for update tracking

### Key Configuration

- `skillbox.centralRepo`: Central storage path (default: `~/.skillbox`)
- `skillbox.defaultAgent`: Target agent for installations (github-copilot, claude-code, cursor, etc.)
- `skillbox.projectInstallDirs`: Custom install directories per project
