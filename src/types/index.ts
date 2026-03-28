// 订阅源类型
export type SourceType = 'github' | 'local';

// Skill 类型
export type SkillType = 'skill' | 'instruction';

// Agent 类型
export type AgentType = 'copilot' | 'openclaw' | 'claude' | 'cursor';

// 安装范围
export type InstallScope = 'project' | 'global';

// 安装方式
export type InstallMethod = 'copy' | 'symlink';

// 订阅源
export interface Source {
    id: string;
    url: string;
    type: SourceType;
    name: string;           // 仓库名: owner/repo 格式
    branch?: string;        // 分支名，不填则使用默认分支
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

// 配置
export interface SkillBoxConfig {
    centralRepo: string;
    defaultAgent: AgentType;
    defaultScope: InstallScope;
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
