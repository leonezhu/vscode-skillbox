import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import simpleGit from 'simple-git';
import { Source, Skill, SourceType, SkillType } from '../types';

export class SourceManager {
    private context: vscode.ExtensionContext;
    private sources: Map<string, Source> = new Map();
    private skills: Map<string, Skill[]> = new Map();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadSources();
        this.loadSkills();
    }

    private loadSources() {
        const saved = this.context.globalState.get<Source[]>('sources', []);
        saved.forEach(s => {
            this.sources.set(s.id, s);
        });
    }

    private loadSkills() {
        const saved = this.context.globalState.get<Record<string, Skill[]>>('skills', {});
        Object.entries(saved).forEach(([id, skills]) => {
            this.skills.set(id, skills);
        });
    }

    private async saveSources() {
        await this.context.globalState.update('sources', Array.from(this.sources.values()));
    }

    private async saveSkills() {
        const skillsObj: Record<string, Skill[]> = {};
        this.skills.forEach((skills, id) => {
            skillsObj[id] = skills;
        });
        await this.context.globalState.update('skills', skillsObj);
    }

    getCentralRepo(): string {
        const config = vscode.workspace.getConfiguration('skillbox');
        let centralRepo = config.get<string>('centralRepo');

        if (!centralRepo) {
            const homeDir = process.env.HOME || process.env.USERPROFILE;
            if (homeDir) {
                centralRepo = path.join(homeDir, '.skillbox');
            } else {
                centralRepo = path.join(this.context.globalStorageUri.fsPath, 'skills');
            }
        } else if (centralRepo.startsWith('~')) {
            const homeDir = process.env.HOME || process.env.USERPROFILE;
            if (homeDir) {
                centralRepo = path.join(homeDir, centralRepo.substring(1));
            }
        }

        if (!fs.existsSync(centralRepo)) {
            fs.mkdirSync(centralRepo, { recursive: true });
        }

        return centralRepo;
    }

    getCacheDir(): string {
        const cacheDir = path.join(this.getCentralRepo(), '.cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        return cacheDir;
    }

    async addSource(url: string, branch?: string): Promise<Source> {
        const id = crypto.randomUUID();

        let type: SourceType = 'github';
        if (url.startsWith('git@') || url.startsWith('git://')) {
            type = 'github';
        } else if (url.startsWith('http://') || url.startsWith('https://')) {
            type = 'github';
        } else {
            type = 'local';
        }

        let name: string;
        if (type === 'github') {
            // Support: https://github.com/owner/repo, git@github.com:owner/repo, https://PAT@github.com/owner/repo
            const match = url.match(/github\.com[/:]([^/@]+\/[^/]+)/);
            name = match ? match[1].replace(/\.git$/, '') : path.basename(url.replace(/\.git$/, ''));
        } else {
            name = `local/${path.basename(url)}`;
        }

        const source: Source = { id, url, type, name, branch };
        this.sources.set(id, source);
        await this.saveSources();

        await this.syncSource(id);

        return source;
    }

    async removeSource(id: string): Promise<void> {
        const source = this.sources.get(id);
        if (source && source.type === 'github') {
            // 删除缓存
            const cachePath = path.join(this.getCacheDir(), id);
            if (fs.existsSync(cachePath)) {
                fs.rmSync(cachePath, { recursive: true });
            }
        }

        this.sources.delete(id);
        this.skills.delete(id);
        await this.saveSources();
        await this.saveSkills();
    }

    async syncSource(id: string): Promise<void> {
        const source = this.sources.get(id);
        if (!source) { return; }

        try {
            let sourceDir: string;

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Syncing ${source.name}...`,
                cancellable: false
            }, async (progress) => {
                if (source.type === 'github') {
                    progress.report({ message: 'Cloning repository...' });
                    const cacheDir = this.getCacheDir();
                    sourceDir = path.join(cacheDir, id);

                    if (fs.existsSync(sourceDir)) {
                        progress.report({ message: 'Updating repository...' });
                        const git = simpleGit(sourceDir);
                        const branch = source.branch || (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
                        await git.checkout(branch);
                        try {
                            await git.pull('origin', branch);
                        } catch {
                            await git.fetch('origin');
                            await git.reset(['--hard', `origin/${branch}`]);
                        }
                    } else {
                        progress.report({ message: 'Cloning repository...' });
                        // Clone default branch first, then checkout target branch
                        execSync(`git clone ${source.url} "${sourceDir}"`, { stdio: 'pipe' });
                        if (source.branch) {
                            progress.report({ message: `Switching to branch ${source.branch}...` });
                            execSync(`git fetch origin "${source.branch}" && git checkout "${source.branch}"`, { cwd: sourceDir, stdio: 'pipe' });
                        }
                    }
                } else {
                    progress.report({ message: 'Reading local path...' });
                    sourceDir = source.url;
                    if (!fs.existsSync(sourceDir)) {
                        vscode.window.showErrorMessage(`Local path does not exist: ${source.url}`);
                        return;
                    }
                }

                progress.report({ message: 'Scanning resources...' });
                const skills = this.scanSkills(sourceDir, id);
                this.skills.set(id, skills);
                await this.saveSkills();

                source.lastSync = new Date().toISOString();
                await this.saveSources();
            });

            vscode.window.showInformationMessage(`Synced ${source.name}: ${this.skills.get(id)?.length || 0} resources found`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to sync ${source.name}: ${error}`);
        }
    }

    private scanSkills(dir: string, sourceId: string): Skill[] {
        const skills: Skill[] = [];

        // 1. Scan common skill directories (recursive)
        const skillDirPaths = ['skills', '.github/skills', '.agents/skills', '.claude/skills', '.cursor/skills'];
        for (const sd of skillDirPaths) {
            const fullDir = path.join(dir, sd);
            if (fs.existsSync(fullDir)) {
                this.scanSkillsRecursive(fullDir, sourceId, skills);
            }
        }

        // 2. Scan instruction directories
        const instrDirPaths = ['instructions', '.github/instructions', '.agents/instructions', 'github/instructions'];
        for (const id of instrDirPaths) {
            const fullDir = path.join(dir, id);
            if (fs.existsSync(fullDir)) {
                fs.readdirSync(fullDir)
                    .filter(f => f.endsWith('.instructions.md'))
                    .forEach(f => {
                        const fp = path.join(fullDir, f);
                        const skill = this.parseInstructionFile(fp, f, 'instruction', sourceId);
                        if (skill) { skills.push(skill); }
                    });
            }
        }

        // 3. Scan agent directories
        const agentDirPaths = ['agents', '.github/agents', '.agents/agents', 'github/agents'];
        for (const ad of agentDirPaths) {
            const fullDir = path.join(dir, ad);
            if (fs.existsSync(fullDir)) {
                fs.readdirSync(fullDir)
                    .filter(f => f.endsWith('.agent.md'))
                    .forEach(f => {
                        const fp = path.join(fullDir, f);
                        const skill = this.parseInstructionFile(fp, f, 'agent', sourceId);
                        if (skill) { skills.push(skill); }
                    });
            }
        }

        // 4. Scan special files
        const specialFiles = ['copilot-instructions.md', 'AGENT.md', 'CLAUDE.md'];
        for (const specialFile of specialFiles) {
            const specialPath = path.join(dir, specialFile);
            if (fs.existsSync(specialPath)) {
                const skill = this.parseInstructionFile(specialPath, specialFile, 'special', sourceId);
                if (skill) { skills.push(skill); }
            }
        }

        // 5. Recursively find SKILL.md files anywhere else
        this.findSkillFiles(dir, sourceId, skills);

        // Deduplicate by path
        const seen = new Set<string>();
        return skills.filter(s => {
            if (seen.has(s.path)) { return false; }
            seen.add(s.path);
            return true;
        });
    }

    private scanSkillsRecursive(skillsDir: string, sourceId: string, skills: Skill[]) {
        fs.readdirSync(skillsDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .forEach(d => {
                const skillPath = path.join(skillsDir, d.name);
                if (fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
                    const skill = this.parseSkillDir(skillPath, d.name, 'skill', sourceId);
                    if (skill) { skills.push(skill); }
                } else {
                    // No SKILL.md here, go deeper
                    this.scanSkillsRecursive(skillPath, sourceId, skills);
                }
            });
    }

    private parseSkillDir(dir: string, name: string, type: SkillType, sourceId: string): Skill | null {
        const skillFile = path.join(dir, 'SKILL.md');
        let description = '';

        if (fs.existsSync(skillFile)) {
            const content = fs.readFileSync(skillFile, 'utf-8');
            const descMatch = content.match(/##\s*Description\s*\n+(.+?)(?=\n##|$)/s);
            description = descMatch ? descMatch[1].trim() : '';
        }

        return {
            id: crypto.randomUUID(),
            name,
            description,
            path: dir,
            type,
            sourceId
        };
    }

    private parseInstructionFile(filePath: string, filename: string, type: SkillType, sourceId: string): Skill | null {
        const content = fs.readFileSync(filePath, 'utf-8');

        let name = filename;
        if (type === 'instruction') {
            name = filename.replace(/\.instructions\.md$/, '');
        } else if (type === 'agent') {
            name = filename.replace(/\.agent\.md$/, '');
        } else if (type === 'special') {
            name = filename;
        }

        const lines = content.split('\n');
        let description = '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                description = trimmed.substring(0, 100) + (trimmed.length > 100 ? '...' : '');
                break;
            }
        }

        return {
            id: crypto.randomUUID(),
            name,
            description,
            path: filePath,
            type,
            sourceId
        };
    }

    private findSkillFiles(dir: string, sourceId: string, skills: Skill[]) {
        const ignoreDirs = ['node_modules', '.git', 'out', 'dist', 'build', 'workflows', '.cache'];

        const scanDirectory = (currentDir: string) => {
            try {
                const entries = fs.readdirSync(currentDir, { withFileTypes: true });

                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        if (ignoreDirs.includes(entry.name)) { continue; }
                        scanDirectory(path.join(currentDir, entry.name));
                    } else if (entry.name === 'SKILL.md') {
                        const skillDir = path.dirname(path.join(currentDir, entry.name));
                        const skillName = path.basename(skillDir);
                        const skill = this.parseSkillDir(skillDir, skillName, 'skill', sourceId);
                        if (skill) {
                            skills.push(skill);
                        }
                    }
                }
            } catch {
                // ignore
            }
        };

        scanDirectory(dir);
    }

    getSources(): Source[] {
        return Array.from(this.sources.values());
    }

    getSkills(sourceId: string): Skill[] {
        return this.skills.get(sourceId) || [];
    }

    getAllSkills(): Skill[] {
        return Array.from(this.skills.values()).flat();
    }

    getSourcePath(sourceId: string): string {
        const source = this.sources.get(sourceId);
        if (!source) { return ''; }

        if (source.type === 'local') {
            return source.url;
        }
        return path.join(this.getCacheDir(), sourceId);
    }

    getSourceName(sourceId: string): string {
        return this.sources.get(sourceId)?.name || '';
    }
}
