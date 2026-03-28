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

    getInstallPath(skill: Skill, agent: AgentType, scope: InstallScope): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (scope === 'project') {
            if (!workspaceFolders || workspaceFolders.length === 0) { return null; }
            const projectRoot = workspaceFolders[0].uri.fsPath;
            return this.resolveProjectPath(skill, agent, projectRoot);
        } else {
            const homeDir = process.env.HOME || process.env.USERPROFILE;
            if (!homeDir) { return null; }
            return this.resolveGlobalPath(skill, agent, homeDir);
        }
    }

    async installToPath(skill: Skill, targetPath: string, method: InstallMethod = 'copy'): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Installing ${skill.name}...`,
            cancellable: false
        }, async () => {
            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            if (skill.type === 'skill') {
                if (method === 'symlink') {
                    await this.linkDirectory(skill.path, targetPath);
                } else {
                    await this.copyDirectory(skill.path, targetPath);
                }
            } else {
                if (method === 'symlink') {
                    await this.linkFile(skill.path, targetPath);
                } else {
                    fs.copyFileSync(skill.path, targetPath);
                }
            }

            await this.saveInstallRecord(skill, targetPath);
        });

        vscode.window.showInformationMessage(`${skill.name} installed successfully!`);
    }

    async update(skill: Skill): Promise<void> {
        await this.installToPath(skill, this.getProjectSkillPath(skill) || '');
    }

    isInstalled(skill: Skill): boolean {
        // 先检查安装记录中的实际路径
        const record = this.installRecords.get(skill.id);
        if (record?.targetPath && fs.existsSync(record.targetPath)) {
            return true;
        }
        // 回退：检查当前 agent 的项目路径
        const projectPath = this.getProjectSkillPath(skill);
        if (projectPath && fs.existsSync(projectPath)) {
            return true;
        }
        return false;
    }

    isInstalledInProject(skill: Skill): boolean {
        const projectPath = this.getProjectSkillPath(skill);
        if (projectPath && fs.existsSync(projectPath)) {
            return true;
        }
        const record = this.installRecords.get(skill.id);
        if (record?.targetPath) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const projectRoot = workspaceFolders?.[0]?.uri.fsPath;
            if (projectRoot && record.targetPath.startsWith(projectRoot) && fs.existsSync(record.targetPath)) {
                return true;
            }
        }
        return false;
    }

    hasUpdate(skill: Skill): boolean {
        return false;
    }

    getProjectSkillPath(skill: Skill): string | null {
        const config = vscode.workspace.getConfiguration('skillbox');
        const agent = config.get<AgentType>('defaultAgent', 'copilot');
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || workspaceFolders.length === 0) { return null; }
        const projectRoot = workspaceFolders[0].uri.fsPath;
        return this.resolveProjectPath(skill, agent, projectRoot);
    }

    async uninstall(skill: Skill): Promise<void> {
        // 先尝试安装记录中的实际路径
        const record = this.installRecords.get(skill.id);
        let removePath: string | null = null;

        if (record?.targetPath && fs.existsSync(record.targetPath)) {
            removePath = record.targetPath;
        } else {
            // 回退：检查当前 agent 的项目路径
            const projectPath = this.getProjectSkillPath(skill);
            if (projectPath && fs.existsSync(projectPath)) {
                removePath = projectPath;
            }
        }

        if (!removePath) {
            vscode.window.showWarningMessage(`${skill.name} is not installed`);
            return;
        }

        fs.rmSync(removePath, { recursive: true });

        this.installRecords.delete(skill.id);
        await this.saveInstallRecords();

        vscode.window.showInformationMessage(`${skill.name} uninstalled successfully!`);
    }

    // Project scope: copilot uses .github, others use their own dirs
    private resolveProjectPath(skill: Skill, agent: AgentType, basePath: string): string {
        if (skill.type === 'special') {
            if (skill.name === 'copilot-instructions.md') {
                return path.join(basePath, '.github', 'copilot-instructions.md');
            } else if (skill.name === 'AGENT.md' || skill.name === 'CLAUDE.md') {
                return path.join(basePath, skill.name);
            }
        }

        if (skill.type === 'instruction') {
            return path.join(basePath, '.github', 'instructions', `${skill.name}.instructions.md`);
        } else if (skill.type === 'agent') {
            return path.join(basePath, '.github', 'agents', `${skill.name}.agent.md`);
        }

        if (agent === 'copilot') {
            return path.join(basePath, '.github', 'skills', skill.name);
        } else if (agent === 'opencode') {
            return path.join(basePath, '.agents', 'skills', skill.name);
        } else if (agent === 'claude') {
            return path.join(basePath, '.claude', 'skills', skill.name);
        } else if (agent === 'cursor') {
            return path.join(basePath, '.cursor', 'skills', skill.name);
        }
        return path.join(basePath, '.skills', skill.name);
    }

    // Global scope: copilot and opencode share ~/.agents/
    private resolveGlobalPath(skill: Skill, agent: AgentType, homeDir: string): string {
        if (skill.type === 'special') {
            if (skill.name === 'AGENT.md' || skill.name === 'CLAUDE.md') {
                return path.join(homeDir, skill.name);
            }
        }

        if (skill.type === 'instruction') {
            return path.join(homeDir, '.agents', 'instructions', `${skill.name}.instructions.md`);
        } else if (skill.type === 'agent') {
            return path.join(homeDir, '.agents', 'agents', `${skill.name}.agent.md`);
        }

        if (agent === 'copilot' || agent === 'opencode') {
            return path.join(homeDir, '.agents', 'skills', skill.name);
        } else if (agent === 'claude') {
            return path.join(homeDir, '.claude', 'skills', skill.name);
        } else if (agent === 'cursor') {
            return path.join(homeDir, '.cursor', 'skills', skill.name);
        }
        return path.join(homeDir, '.skills', skill.name);
    }

    private async copyDirectory(src: string, dest: string): Promise<void> {
        if (fs.existsSync(dest)) {
            fs.rmSync(dest, { recursive: true });
        }
        fs.cpSync(src, dest, { recursive: true });
    }

    private async linkDirectory(src: string, dest: string): Promise<void> {
        if (fs.existsSync(dest)) {
            const stat = fs.lstatSync(dest);
            if (stat.isSymbolicLink()) {
                fs.unlinkSync(dest);
            } else {
                fs.rmSync(dest, { recursive: true });
            }
        }
        fs.symlinkSync(src, dest, 'junction');
    }

    private async linkFile(src: string, dest: string): Promise<void> {
        if (fs.existsSync(dest)) {
            fs.unlinkSync(dest);
        }
        fs.symlinkSync(src, dest, 'file');
    }

    private async saveInstallRecord(skill: Skill, targetPath: string): Promise<void> {
        let commitHash: string | undefined;
        try {
            const sourcePath = this.sourceManager.getSourcePath(skill.sourceId);
            const git = simpleGit(sourcePath);
            commitHash = (await git.revparse(['HEAD'])).trim();
        } catch {
            // ignore
        }

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
