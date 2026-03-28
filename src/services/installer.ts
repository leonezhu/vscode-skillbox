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
            // Global installs go to ~/.skillbox/ (the central hub)
            const centralRepo = this.sourceManager.getCentralRepo();
            return this.resolveGlobalPath(skill, agent, centralRepo);
        }
    }

    async installToPath(skill: Skill, targetPath: string, method: InstallMethod = 'copy'): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Installing ${skill.name}...`,
            cancellable: false
        }, async () => {
            const centralRepo = this.sourceManager.getCentralRepo();
            const hubPath = this.getHubPath(skill, centralRepo);
            const hubDir = path.dirname(hubPath);
            if (!fs.existsSync(hubDir)) {
                fs.mkdirSync(hubDir, { recursive: true });
            }

            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            if (method === 'copy') {
                // Copy: hub gets a copy, project gets a copy
                if (skill.type === 'skill') {
                    await this.copyDirectory(skill.path, hubPath);
                    await this.copyDirectory(skill.path, targetPath);
                } else {
                    fs.copyFileSync(skill.path, hubPath);
                    fs.copyFileSync(skill.path, targetPath);
                }
            } else {
                // Symlink: hub gets the actual copy, project symlinks to hub
                if (skill.type === 'skill') {
                    await this.copyDirectory(skill.path, hubPath);
                    await this.linkDirectory(hubPath, targetPath);
                } else {
                    fs.copyFileSync(skill.path, hubPath);
                    await this.linkFile(hubPath, targetPath);
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
        const record = this.installRecords.get(skill.id);
        if (record?.targetPath && fs.existsSync(record.targetPath)) {
            return true;
        }
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
        const record = this.installRecords.get(skill.id);
        let removePath: string | null = null;

        if (record?.targetPath && fs.existsSync(record.targetPath)) {
            removePath = record.targetPath;
        } else {
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

        // Remove hub symlink
        await this.removeFromHub(skill);

        this.installRecords.delete(skill.id);
        await this.saveInstallRecords();

        vscode.window.showInformationMessage(`${skill.name} uninstalled successfully!`);
    }

    private async removeFromHub(skill: Skill): Promise<void> {
        const centralRepo = this.sourceManager.getCentralRepo();
        const hubPath = this.getHubPath(skill, centralRepo);
        if (fs.existsSync(hubPath)) {
            fs.rmSync(hubPath, { recursive: true });
        }
    }

    private getHubPath(skill: Skill, centralRepo: string): string {
        if (skill.type === 'special') {
            const sourceName = this.sourceManager.getSourceName(skill.sourceId);
            const prefix = sourceName.replace(/[\/\\]/g, '-');
            return path.join(centralRepo, 'special', `${prefix}-${skill.name.toLowerCase()}`);
        }
        if (skill.type === 'instruction') {
            return path.join(centralRepo, 'instructions', `${skill.name}.instructions.md`);
        }
        if (skill.type === 'agent') {
            return path.join(centralRepo, 'agents', `${skill.name}.agent.md`);
        }
        return path.join(centralRepo, 'skills', skill.name);
    }

    // Project scope paths
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

    // Global scope: all go to ~/.skillbox/ (the central hub)
    private resolveGlobalPath(skill: Skill, agent: AgentType, centralRepo: string): string {
        if (skill.type === 'special') {
            // Special files get {source-prefix} to avoid collisions
            const sourceName = this.sourceManager.getSourceName(skill.sourceId);
            const prefix = sourceName.replace(/[\/\\]/g, '-');
            if (skill.name === 'copilot-instructions.md') {
                return path.join(centralRepo, 'special', `${prefix}-copilot-instructions.md`);
            } else if (skill.name === 'AGENT.md' || skill.name === 'CLAUDE.md') {
                return path.join(centralRepo, 'special', `${prefix}-${skill.name.toLowerCase()}`);
            }
        }

        if (skill.type === 'instruction') {
            return path.join(centralRepo, 'instructions', `${skill.name}.instructions.md`);
        } else if (skill.type === 'agent') {
            return path.join(centralRepo, 'agents', `${skill.name}.agent.md`);
        }

        // Skills
        return path.join(centralRepo, 'skills', skill.name);
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
