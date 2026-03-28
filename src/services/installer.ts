import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import simpleGit from 'simple-git';
import { SourceManager } from '../managers/sourceManager';
import { Skill, AgentType, InstallScope, InstallMethod } from '../types';

export class SkillInstaller {
    private installRecords: Map<string, InstallRecord> = new Map();

    constructor(private sourceManager: SourceManager, private context: vscode.ExtensionContext) {
        this.loadInstallRecords();
    }

    private loadInstallRecords() {
        const saved = this.context.globalState.get<InstallRecord[]>('installRecords', []);
        saved.forEach(r => {
            this.installRecords.set(r.skillId, r);
        });
    }

    private async saveInstallRecords() {
        await this.context.globalState.update('installRecords', Array.from(this.installRecords.values()));
    }

    async install(skill: Skill): Promise<void> {
        const config = vscode.workspace.getConfiguration('skillbox');
        const agent = config.get<AgentType>('defaultAgent', 'copilot');
        const scope = config.get<InstallScope>('defaultScope', 'project');
        const method = config.get<InstallMethod>('installMethod', 'copy');

        const targetPath = await this.getTargetPath(skill, agent, scope);
        
        if (!targetPath) {
            vscode.window.showErrorMessage('Please open a project folder first');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Installing ${skill.name}...`,
            cancellable: false
        }, async () => {
            // 确保目标目录存在
            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            // 安装 skill
            if (method === 'symlink') {
                await this.linkDirectory(skill.path, targetPath);
            } else {
                await this.copyDirectory(skill.path, targetPath);
            }

            // 保存安装记录
            await this.saveInstallRecord(skill, targetPath);
        });

        vscode.window.showInformationMessage(`${skill.name} installed successfully!`);
    }

    async update(skill: Skill): Promise<void> {
        // 更新就是重新安装
        await this.install(skill);
    }

    isInstalled(skill: Skill): boolean {
        // 检查项目目录中是否存在
        const projectPath = this.getProjectSkillPath(skill);
        if (projectPath && fs.existsSync(projectPath)) {
            return true;
        }
        return this.installRecords.has(skill.id);
    }

    hasUpdate(skill: Skill): boolean {
        // 暂时返回 false，更新检查需要异步实现
        // 可以在后续版本中添加
        return false;
    }

    getProjectSkillPath(skill: Skill): string | null {
        const config = vscode.workspace.getConfiguration('skillbox');
        const agent = config.get<AgentType>('defaultAgent', 'copilot');
        const scope = config.get<InstallScope>('defaultScope', 'project');

        const workspaceFolders = vscode.workspace.workspaceFolders;
        
        if (scope === 'project') {
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return null;
            }
            const projectRoot = workspaceFolders[0].uri.fsPath;
            
            switch (agent) {
                case 'copilot':
                    return path.join(projectRoot, '.github', 'skills', skill.name);
                case 'opencode':
                    return path.join(projectRoot, '.agents', 'skills', skill.name);
                case 'claude':
                    return path.join(projectRoot, '.claude', 'skills', skill.name);
                case 'cursor':
                    return path.join(projectRoot, '.cursor', 'skills', skill.name);
                default:
                    return path.join(projectRoot, '.skills', skill.name);
            }
        }
        return null;
    }

    async uninstall(skill: Skill): Promise<void> {
        const projectPath = this.getProjectSkillPath(skill);
        
        if (!projectPath || !fs.existsSync(projectPath)) {
            vscode.window.showWarningMessage(`${skill.name} is not installed in current project`);
            return;
        }

        // 删除目录
        fs.rmSync(projectPath, { recursive: true });
        
        // 删除记录
        this.installRecords.delete(skill.id);
        await this.saveInstallRecords();

        vscode.window.showInformationMessage(`${skill.name} uninstalled successfully!`);
    }

    private async getTargetPath(skill: Skill, agent: AgentType, scope: InstallScope): Promise<string | null> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        
        if (scope === 'project') {
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return null;
            }
            const projectRoot = workspaceFolders[0].uri.fsPath;
            
            switch (agent) {
                case 'copilot':
                    if (skill.type === 'instruction') {
                        return path.join(projectRoot, '.github', 'instructions', skill.name);
                    }
                    return path.join(projectRoot, '.github', 'skills', skill.name);
                case 'opencode':
                    return path.join(projectRoot, '.agents', 'skills', skill.name);
                case 'claude':
                    return path.join(projectRoot, '.claude', 'skills', skill.name);
                case 'cursor':
                    return path.join(projectRoot, '.cursor', 'skills', skill.name);
                default:
                    return path.join(projectRoot, '.skills', skill.name);
            }
        } else {
            // Global scope
            const homeDir = process.env.HOME || process.env.USERPROFILE;
            if (!homeDir) {return null;}
            
            switch (agent) {
                case 'copilot':
                    return path.join(homeDir, '.github', 'copilot', 'skills', skill.name);
                case 'opencode':
                    return path.join(homeDir, '.agents', 'skills', skill.name);
                case 'claude':
                    return path.join(homeDir, '.claude', 'skills', skill.name);
                case 'cursor':
                    return path.join(homeDir, '.cursor', 'skills', skill.name);
                default:
                    return path.join(homeDir, '.skills', skill.name);
            }
        }
    }

    private async copyDirectory(src: string, dest: string): Promise<void> {
        // 如果目标已存在，先删除
        if (fs.existsSync(dest)) {
            fs.rmSync(dest, { recursive: true });
        }

        // 复制目录
        fs.cpSync(src, dest, { recursive: true });
    }

    private async linkDirectory(src: string, dest: string): Promise<void> {
        // 如果目标已存在，先删除
        if (fs.existsSync(dest)) {
            const stat = fs.lstatSync(dest);
            if (stat.isSymbolicLink()) {
                fs.unlinkSync(dest);
            } else {
                fs.rmSync(dest, { recursive: true });
            }
        }

        // 创建符号链接
        fs.symlinkSync(src, dest, 'junction');
    }

    private async saveInstallRecord(skill: Skill, targetPath: string): Promise<void> {
        // 获取当前 commit hash
        let commitHash: string | undefined;
        try {
            const sourcePath = this.sourceManager.getSourcePath(skill.sourceId);
            const git = simpleGit(sourcePath);
            commitHash = (await git.revparse(['HEAD'])).trim();
        } catch {
            // 忽略 git 错误
        }

        // 保存记录
        const record: InstallRecord = {
            skillId: skill.id,
            installedAt: new Date().toISOString(),
            targetPath,
            commitHash
        };

        this.installRecords.set(skill.id, record);
        await this.saveInstallRecords();
    }
}

interface InstallRecord {
    skillId: string;
    installedAt: string;
    targetPath: string;
    commitHash?: string;
}
