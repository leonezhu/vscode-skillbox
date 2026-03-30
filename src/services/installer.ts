import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import simpleGit from 'simple-git';
import { SourceManager } from '../managers/sourceManager';
import { Skill, AgentType, InstallScope, InstallMethod, getAgentPaths } from '../types';

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

    getInstallPath(skill: Skill, agent: AgentType, scope: InstallScope, projectRoot?: string): string | null {
        if (scope === 'project') {
            if (!projectRoot) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) { return null; }
                projectRoot = workspaceFolders[0].uri.fsPath;
            }
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
            const centralRepo = this.sourceManager.getCentralRepo();
            const sourcePath = this.sourceManager.getSourcePath(skill.sourceId);
            const isFromHub = sourcePath === centralRepo || path.resolve(sourcePath) === path.resolve(centralRepo);

            // Ensure target dir exists
            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            if (isFromHub) {
                // Skill is already in hub, install to project directly
                if (method === 'symlink') {
                    if (skill.type === 'skill') {
                        await this.linkDirectory(skill.path, targetPath);
                    } else {
                        await this.linkFile(skill.path, targetPath);
                    }
                } else {
                    if (skill.type === 'skill') {
                        await this.copyDirectory(skill.path, targetPath);
                    } else {
                        fs.copyFileSync(skill.path, targetPath);
                    }
                }
            } else {
                // Skill from external source: copy to hub, then install to project
                const hubPath = this.getHubPath(skill, centralRepo);
                const hubDir = path.dirname(hubPath);
                if (!fs.existsSync(hubDir)) {
                    fs.mkdirSync(hubDir, { recursive: true });
                }

                // Always copy to hub
                if (skill.type === 'skill') {
                    await this.copyDirectory(skill.path, hubPath);
                } else {
                    fs.copyFileSync(skill.path, hubPath);
                }

                // Install to project
                if (method === 'symlink') {
                    // Symlink: project -> hub
                    if (skill.type === 'skill') {
                        await this.linkDirectory(hubPath, targetPath);
                    } else {
                        await this.linkFile(hubPath, targetPath);
                    }
                } else {
                    // Copy: independent copy in project
                    if (skill.type === 'skill') {
                        await this.copyDirectory(hubPath, targetPath);
                    } else {
                        fs.copyFileSync(hubPath, targetPath);
                    }
                }
            }

            await this.saveInstallRecord(skill, targetPath);
        });

        vscode.window.showInformationMessage(`${skill.name} installed successfully!`);
    }

    async update(skill: Skill): Promise<void> {
        await this.installToPath(skill, this.getProjectSkillPath(skill) || '');
    }

    getInstallInfo(skill: Skill): { scope: InstallScope; targetPath: string } | null {
        const record = this.installRecords.get(skill.id);
        if (record?.targetPath && fs.existsSync(record.targetPath)) {
            // Check if target is inside any workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const isInWorkspace = workspaceFolders?.some(f => record.targetPath.startsWith(f.uri.fsPath + path.sep) || record.targetPath === f.uri.fsPath);
            return { scope: isInWorkspace ? 'project' : 'global', targetPath: record.targetPath };
        }
        const projectPath = this.getProjectSkillPath(skill);
        if (projectPath && fs.existsSync(projectPath)) {
            return { scope: 'project', targetPath: projectPath };
        }
        return null;
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

    getProjectSkillPath(skill: Skill, projectRoot?: string): string | null {
        const config = vscode.workspace.getConfiguration('skillbox');
        const agent = config.get<AgentType>('defaultAgent', 'copilot');

        if (!projectRoot) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) { return null; }
            projectRoot = workspaceFolders[0].uri.fsPath;
        }
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
        // Don't touch hub - it's a permanent pool

        this.installRecords.delete(skill.id);
        await this.saveInstallRecords();

        vscode.window.showInformationMessage(`${skill.name} uninstalled from project`);
    }

    private getHubPath(skill: Skill, centralRepo: string): string {
        const sourceName = this.sourceManager.getSourceName(skill.sourceId);
        const sourceDir = sourceName.replace(/[\/\\]/g, '-');

        if (skill.type === 'special') {
            return path.join(centralRepo, 'special', sourceDir, skill.name.toLowerCase());
        }
        if (skill.type === 'instruction') {
            return path.join(centralRepo, 'instructions', sourceDir, `${skill.name}.instructions.md`);
        }
        if (skill.type === 'agent') {
            return path.join(centralRepo, 'agents', sourceDir, `${skill.name}.agent.md`);
        }
        return path.join(centralRepo, 'skills', sourceDir, skill.name);
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

        const agentPaths = getAgentPaths(agent);
        return path.join(basePath, agentPaths.project, skill.name);
    }

    private resolveGlobalPath(skill: Skill, agent: AgentType, homeDir: string): string {
        if (skill.type === 'special') {
            if (skill.name === 'copilot-instructions.md') {
                return path.join(homeDir, '.github', 'copilot-instructions.md');
            } else if (skill.name === 'AGENT.md' || skill.name === 'CLAUDE.md') {
                return path.join(homeDir, skill.name);
            }
        }

        if (skill.type === 'instruction') {
            return path.join(homeDir, '.agents', 'instructions', `${skill.name}.instructions.md`);
        } else if (skill.type === 'agent') {
            return path.join(homeDir, '.agents', 'agents', `${skill.name}.agent.md`);
        }

        const agentPaths = getAgentPaths(agent);
        const globalBase = agentPaths.global.replace(/^~/, homeDir);
        return path.join(globalBase, skill.name);
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
