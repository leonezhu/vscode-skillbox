import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
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

    async addSource(url: string, branch?: string): Promise<Source> {
        const id = crypto.randomUUID();
        
        // 支持3种格式：URL、git https、git ssh
        let type: SourceType = 'github';
        if (url.startsWith('git@') || url.startsWith('git://')) {
            type = 'github';
        } else if (url.startsWith('http://') || url.startsWith('https://')) {
            type = 'github';
        } else {
            type = 'local';
        }
        
        // 解析仓库名称
        let name: string;
        if (type === 'github') {
            // 匹配多种格式：
            // https://github.com/owner/repo
            // git@github.com:owner/repo.git
            // git://github.com/owner/repo.git
            const match = url.match(/github\.com[/:]([^/]+\/[^/]+)/);
            name = match ? match[1].replace(/\.git$/, '') : path.basename(url.replace(/\.git$/, ''));
        } else {
            // 本地仓库使用 local/folder-name 格式
            name = `local/${path.basename(url)}`;
        }

        const source: Source = { id, url, type, name, branch };
        this.sources.set(id, source);
        await this.saveSources();

        // 同步并扫描 skills
        await this.syncSource(id);

        return source;
    }

    async removeSource(id: string): Promise<void> {
        this.sources.delete(id);
        this.skills.delete(id);
        await this.saveSources();
        await this.saveSkills();
    }

    async syncSource(id: string): Promise<void> {
        const source = this.sources.get(id);
        if (!source) {return;}

        const centralRepo = this.getCentralRepo();
        const sourceDir = path.join(centralRepo, id);

        try {
            if (source.type === 'github') {
                // Clone 或 pull
                if (fs.existsSync(sourceDir)) {
                    const git = simpleGit(sourceDir);
                    if (source.branch) {
                        await git.checkout(source.branch);
                    }
                    await git.pull();
                } else {
                    const cloneOptions = source.branch ? ['--branch', source.branch] : [];
                    await simpleGit().clone(source.url, sourceDir, cloneOptions);
                }
            } else {
                // 本地源 - 创建符号链接或复制
                if (!fs.existsSync(sourceDir)) {
                    // 检查原始路径是否存在
                    if (!fs.existsSync(source.url)) {
                        vscode.window.showErrorMessage(`Local path does not exist: ${source.url}`);
                        return;
                    }
                    fs.symlinkSync(source.url, sourceDir, 'junction');
                }
            }

            // 扫描 skills
            const skills = this.scanSkills(sourceDir, id);
            this.skills.set(id, skills);
            await this.saveSkills();

            // 更新同步时间
            source.lastSync = new Date().toISOString();
            await this.saveSources();
            
            vscode.window.showInformationMessage(`Synced ${source.name}: ${skills.length} resources found`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to sync ${source.name}: ${error}`);
        }
    }

    private scanSkills(dir: string, sourceId: string): Skill[] {
        const skills: Skill[] = [];
        
        // 1. 扫描 skills/ 目录 - 包含 SKILL.md 的目录
        const skillsDir = path.join(dir, 'skills');
        if (fs.existsSync(skillsDir)) {
            fs.readdirSync(skillsDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .forEach(d => {
                    const skillPath = path.join(skillsDir, d.name);
                    const skill = this.parseSkillDir(skillPath, d.name, 'skill', sourceId);
                    if (skill) {skills.push(skill);}
                });
        }

        // 2. 扫描 instructions/ 目录 - .instructions.md 文件
        const instructionsDir = path.join(dir, 'instructions');
        if (fs.existsSync(instructionsDir)) {
            fs.readdirSync(instructionsDir)
                .filter(f => f.endsWith('.instructions.md'))
                .forEach(f => {
                    const instructionPath = path.join(instructionsDir, f);
                    const skill = this.parseInstructionFile(instructionPath, f, 'instruction', sourceId);
                    if (skill) {skills.push(skill);}
                });
        }

        // 3. 扫描 agents/ 目录 - .agent.md 文件
        const agentsDir = path.join(dir, 'agents');
        if (fs.existsSync(agentsDir)) {
            fs.readdirSync(agentsDir)
                .filter(f => f.endsWith('.agent.md'))
                .forEach(f => {
                    const agentPath = path.join(agentsDir, f);
                    const skill = this.parseInstructionFile(agentPath, f, 'agent', sourceId);
                    if (skill) {skills.push(skill);}
                });
        }

        // 4. 扫描特殊文件（copilot-instructions.md, AGENT.md, CLAUDE.md）
        const specialFiles = ['copilot-instructions.md', 'AGENT.md', 'CLAUDE.md'];
        for (const specialFile of specialFiles) {
            const specialPath = path.join(dir, specialFile);
            if (fs.existsSync(specialPath)) {
                const skill = this.parseInstructionFile(specialPath, specialFile, 'special', sourceId);
                if (skill) {skills.push(skill);}
            }
        }

        // 5. 递归查找其他位置的 SKILL.md 文件
        this.findSkillFiles(dir, sourceId, skills);

        return skills;
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
        
        // 从文件名提取名称（去掉后缀）
        let name = filename;
        if (type === 'instruction') {
            name = filename.replace(/\.instructions\.md$/, '');
        } else if (type === 'agent') {
            name = filename.replace(/\.agent\.md$/, '');
        } else if (type === 'special') {
            // 特殊文件保留原名
            name = filename;
        }

        // 尝试从内容中提取描述（第一段非标题内容）
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
        // 忽略已处理的目录
        const ignoreDirs = ['node_modules', '.git', 'out', 'dist', 'build', 'skills', 'instructions', 'agents', 'workflows'];
        
        const scanDirectory = (currentDir: string) => {
            try {
                const entries = fs.readdirSync(currentDir, { withFileTypes: true });
                
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        if (ignoreDirs.includes(entry.name)) {continue;}
                        scanDirectory(path.join(currentDir, entry.name));
                    } else if (entry.name === 'SKILL.md') {
                        // 找到 SKILL.md，解析这个目录
                        const skillDir = path.dirname(path.join(currentDir, entry.name));
                        const skillName = path.basename(skillDir);
                        const skill = this.parseSkillDir(skillDir, skillName, 'skill', sourceId);
                        if (skill) {
                            skills.push(skill);
                        }
                    }
                }
            } catch {
                // 忽略无权限目录
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
        const centralRepo = this.getCentralRepo();
        return path.join(centralRepo, sourceId);
    }

    private getCentralRepo(): string {
        const config = vscode.workspace.getConfiguration('skillbox');
        let centralRepo = config.get<string>('centralRepo');
        
        if (!centralRepo) {
            // 默认使用 ~/.skillbox/
            const homeDir = process.env.HOME || process.env.USERPROFILE;
            if (homeDir) {
                centralRepo = path.join(homeDir, '.skillbox');
            } else {
                centralRepo = path.join(this.context.globalStorageUri.fsPath, 'skills');
            }
        } else if (centralRepo.startsWith('~')) {
            // 展开 ~ 为 home 目录
            const homeDir = process.env.HOME || process.env.USERPROFILE;
            if (homeDir) {
                centralRepo = path.join(homeDir, centralRepo.substring(1));
            }
        }
        
        // 确保目录存在
        if (!fs.existsSync(centralRepo)) {
            fs.mkdirSync(centralRepo, { recursive: true });
        }
        
        return centralRepo;
    }
}
