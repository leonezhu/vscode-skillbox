import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import simpleGit from 'simple-git';
import { SourceManager } from '../managers/sourceManager';
import { Skill, AgentType, InstallScope } from '../types';

export class SkillInstaller {
    constructor(private sourceManager: SourceManager) {}

    async install(skill: Skill): Promise<void> {
        const config = vscode.workspace.getConfiguration('skillbox');
        const agent = config.get<AgentType>('defaultAgent', 'copilot');
        const scope = config.get<InstallScope>('defaultScope', 'project');

        const targetPath = await this.getTargetPath(skill, agent, scope);
        
        if (!targetPath) {
            vscode.window.showErrorMessage('请先打开一个项目文件夹');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `安装 ${skill.name}...`,
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

        vscode.window.showInformationMessage(`✅ ${skill.name} 安装成功!`);
    }

    async update(skill: Skill): Promise<void> {
        // 更新就是重新安装
        await this.install(skill);
    }

    isInstalled(skill: Skill): boolean {
        const records = this.getInstallRecords();
        return records.some(r => r.skillId === skill.id);
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
        const records = this.getInstallRecords();
        
        // 获取当前 commit hash
        let commitHash: string | undefined;
        try {
            const sourcePath = this.sourceManager.getSourcePath(skill.sourceId);
            const git = simpleGit(sourcePath);
            commitHash = (await git.revparse(['HEAD'])).trim();
        } catch {
            // 忽略 git 错误
        }

        // 更新或添加记录
        const existingIndex = records.findIndex(r => r.skillId === skill.id);
        const record = {
            skillId: skill.id,
            installedAt: new Date().toISOString(),
            targetPath,
            commitHash
        };

        if (existingIndex >= 0) {
            records[existingIndex] = record;
        } else {
            records.push(record);
        }

        // 保存到 globalState
        await vscode.commands.executeCommand('skillbox.saveInstallRecords', records);
    }

    private getInstallRecords(): InstallRecord[] {
        // 这里应该从 context.globalState 获取，但为了简化先用文件
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return [];
        }

        const recordFile = path.join(
            workspaceFolders[0].uri.fsPath,
            '.skillbox',
            'install-records.json'
        );

        if (!fs.existsSync(recordFile)) {
            return [];
        }

        try {
            return JSON.parse(fs.readFileSync(recordFile, 'utf-8'));
        } catch {
            return [];
        }
    }
}

interface InstallRecord {
    skillId: string;
    installedAt: string;
    targetPath: string;
    commitHash?: string;
}
