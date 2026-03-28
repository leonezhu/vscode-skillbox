import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import simpleGit from 'simple-git';
import { SourceManager } from '../managers/sourceManager';
import { Skill, AgentType, InstallScope } from '../types';

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

            // 复制 skill 目录
            await this.copyDirectory(skill.path, targetPath);

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
        return this.installRecords.has(skill.id);
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
                case 'openclaw':
                    return path.join(projectRoot, '.agents', 'skills', skill.name);
                case 'claude':
                    return path.join(projectRoot, '.claude', 'skills', skill.name);
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
                case 'openclaw':
                    return path.join(homeDir, '.openclaw', 'skills', skill.name);
                case 'claude':
                    return path.join(homeDir, '.claude', 'skills', skill.name);
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
