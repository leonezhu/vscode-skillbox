import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import simpleGit from 'simple-git';
import { Source, Skill, SourceType } from '../types';

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
        const type: SourceType = url.startsWith('http') || url.startsWith('git@') ? 'github' : 'local';
        
        // 解析仓库名称
        let name: string;
        if (type === 'github') {
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
            
            vscode.window.showInformationMessage(`Synced ${source.name}: ${skills.length} skills found`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to sync ${source.name}: ${error}`);
        }
    }

    private scanSkills(dir: string, sourceId: string): Skill[] {
        const skills: Skill[] = [];
        
        // 递归查找所有 SKILL.md 文件
        this.findSkillFiles(dir, sourceId, skills);
        
        // 如果没找到 SKILL.md，回退到传统扫描方式
        if (skills.length === 0) {
            // 扫描 skills/ 目录
            const skillsDir = path.join(dir, 'skills');
            if (fs.existsSync(skillsDir)) {
                fs.readdirSync(skillsDir, { withFileTypes: true })
                    .filter(d => d.isDirectory())
                    .forEach(d => {
                        const skillPath = path.join(skillsDir, d.name);
                        const skill = this.parseSkill(skillPath, d.name, 'skill', sourceId);
                        if (skill) {skills.push(skill);}
                    });
            }

            // 扫描 instructions/ 目录
            const instructionsDir = path.join(dir, 'instructions');
            if (fs.existsSync(instructionsDir)) {
                fs.readdirSync(instructionsDir, { withFileTypes: true })
                    .filter(d => d.isDirectory())
                    .forEach(d => {
                        const instructionPath = path.join(instructionsDir, d.name);
                        const skill = this.parseSkill(instructionPath, d.name, 'instruction', sourceId);
                        if (skill) {skills.push(skill);}
                    });
            }
        }

        return skills;
    }

    private findSkillFiles(dir: string, sourceId: string, skills: Skill[]) {
        // 忽略的目录
        const ignoreDirs = ['node_modules', '.git', 'out', 'dist', 'build'];
        
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
                        const relativePath = path.relative(dir, skillDir);
                        const skillName = path.basename(skillDir);
                        const skill = this.parseSkill(skillDir, skillName, 'skill', sourceId);
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

    private parseSkill(dir: string, name: string, type: 'skill' | 'instruction', sourceId: string): Skill | null {
        const skillFile = path.join(dir, 'SKILL.md');
        if (!fs.existsSync(skillFile)) {
            // 如果没有 SKILL.md，就只返回基本信息
            return {
                id: crypto.randomUUID(),
                name,
                description: '',
                path: dir,
                type,
                sourceId
            };
        }

        const content = fs.readFileSync(skillFile, 'utf-8');
        const descMatch = content.match(/##\s*Description\s*\n+(.+?)(?=\n##|$)/s);
        const description = descMatch ? descMatch[1].trim() : '';

        return {
            id: crypto.randomUUID(),
            name,
            description,
            path: dir,
            type,
            sourceId
        };
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
            
            if (!fs.existsSync(centralRepo)) {
                fs.mkdirSync(centralRepo, { recursive: true });
            }
        }
        
        return centralRepo;
    }
}
