// 订阅源类型
export type SourceType = 'github' | 'local';

// Skill 类型
export type SkillType = 'skill' | 'instruction' | 'agent' | 'special';

// Agent 类型
export type AgentType =
    | 'github-copilot' | 'opencode' | 'claude-code' | 'cursor'
    | 'codex' | 'cline' | 'gemini-cli' | 'augment' | 'windsurf'
    | 'openclaw' | 'roo' | 'continue' | 'goose' | 'cline'
    | 'copilot'; // alias for github-copilot

// 安装范围
export type InstallScope = 'project' | 'global';

// 安装方式
export type InstallMethod = 'copy' | 'symlink';

// Agent path mapping
export const AGENT_PATHS: Record<string, { project: string; global: string; label: string }> = {
    'github-copilot': { project: '.github/skills', global: '~/.copilot/skills', label: 'GitHub Copilot' },
    'copilot':       { project: '.github/skills', global: '~/.copilot/skills', label: 'GitHub Copilot' },
    'opencode':      { project: '.agents/skills', global: '~/.config/opencode/skills', label: 'OpenCode' },
    'claude-code':   { project: '.claude/skills', global: '~/.claude/skills', label: 'Claude Code' },
    'cursor':        { project: '.agents/skills', global: '~/.cursor/skills', label: 'Cursor' },
    'codex':         { project: '.agents/skills', global: '~/.codex/skills', label: 'Codex' },
    'cline':         { project: '.agents/skills', global: '~/.agents/skills', label: 'Cline' },
    'gemini-cli':    { project: '.agents/skills', global: '~/.gemini/skills', label: 'Gemini CLI' },
    'windsurf':      { project: '.windsurf/skills', global: '~/.codeium/windsurf/skills', label: 'Windsurf' },
    'openclaw':      { project: 'skills', global: '~/.openclaw/skills', label: 'OpenClaw' },
    'trae':          { project: '.trae/skills', global: '~/.trae/skills', label: 'Trae' },
    'codebuddy':     { project: '.codebuddy/skills', global: '~/.codebuddy/skills', label: 'CodeBuddy' },
    'droid':         { project: '.factory/skills', global: '~/.factory/skills', label: 'Droid' },
    'amp':           { project: '.agents/skills', global: '~/.config/agents/skills', label: 'Amp' },
    'kilo':          { project: '.kilocode/skills', global: '~/.kilocode/skills', label: 'Kilo Code' },
    'mux':           { project: '.mux/skills', global: '~/.mux/skills', label: 'Mux' },
    'pi':            { project: '.pi/skills', global: '~/.pi/agent/skills', label: 'Pi' },
    'qoder':         { project: '.qoder/skills', global: '~/.qoder/skills', label: 'Qoder' },
    'qwen-code':     { project: '.qwen/skills', global: '~/.qwen/skills', label: 'Qwen Code' },
    'zencoder':      { project: '.zencoder/skills', global: '~/.zencoder/skills', label: 'Zencoder' },
    'crush':         { project: '.crush/skills', global: '~/.config/crush/skills', label: 'Crush' },
    'antigravity':   { project: '.agents/skills', global: '~/.gemini/antigravity/skills', label: 'Antigravity' },
    'trae-cn':       { project: '.trae/skills', global: '~/.trae-cn/skills', label: 'Trae CN' },
    'kimi-cli':      { project: '.agents/skills', global: '~/.config/agents/skills', label: 'Kimi Code CLI' }
};

export function getAgentPaths(agent: string): { project: string; global: string; label: string } {
    // Resolve 'copilot' alias to 'github-copilot'
    const key = agent === 'copilot' ? 'copilot' : agent;
    return AGENT_PATHS[key] || AGENT_PATHS['github-copilot'];
}

export function getAgentEnumValues(): string[] {
    const seen = new Set<string>();
    const values: string[] = [];
    for (const [key, val] of Object.entries(AGENT_PATHS)) {
        if (key === 'copilot') continue; // skip alias
        if (!seen.has(val.label)) {
            seen.add(val.label);
            values.push(key);
        }
    }
    return values;
}

// 订阅源
export interface Source {
    id: string;
    url: string;
    type: SourceType;
    name: string;
    branch?: string;
    lastSync?: string;
}

// Skill
export interface Skill {
    id: string;
    name: string;
    description: string;
    path: string;
    type: SkillType;
    sourceId: string;
}

// 安装记录
export interface InstallRecord {
    skillId: string;
    installedAt: string;
    targetPath: string;
    commitHash?: string;
}

// Tree Node
export interface SkillTreeNode {
    label: string;
    tooltip?: string;
    description?: string;
    contextValue?: string;
    source?: Source;
    skill?: Skill;
    children?: SkillTreeNode[];
}
