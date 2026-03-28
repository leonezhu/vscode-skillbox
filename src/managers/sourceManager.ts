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
    }

    private loadSources() {
        const saved = this.context.globalState.get<Source[]>('sources', []);
        saved.forEach(s => {
            this.sources.set(s.id, s);
        });
    }

    private async saveSources() {
        await this.context.globalState.update('sources', Array.from(this.sources.values()));
    }

    async addSource(url: string): Promise<Source> {
        const id = crypto.randomUUID();
        const type: SourceType = url.startsWith('http') ? 'github' : 'local';
        const name = path.basename(url.replace(/\.git$/, ''));

        const source: Source = { id, url, type, name };
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
    }

    async syncSource(id: string): Promise<void> {
        const source = this.sources.get(id);
        if (!source) {return;}

        const centralRepo = this.getCentralRepo();
        const sourceDir = path.join(centralRepo, id);

        if (source.type === 'github') {
            // Clone 或 pull
            if (fs.existsSync(sourceDir)) {
                await simpleGit(sourceDir).pull();
            } else {
                await simpleGit().clone(source.url, sourceDir);
            }
        } else {
            // 本地源 - 创建符号链接或复制
            if (!fs.existsSync(sourceDir)) {
                fs.symlinkSync(source.url, sourceDir, 'junction');
            }
        }

        // 扫描 skills
        const skills = this.scanSkills(sourceDir, id);
        this.skills.set(id, skills);

        // 更新同步时间
        source.lastSync = new Date().toISOString();
        await this.saveSources();
    }

    private scanSkills(dir: string, sourceId: string): Skill[] {
        const skills: Skill[] = [];
        
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

        return skills;
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
            centralRepo = path.join(this.context.globalStorageUri.fsPath, 'skills');
            if (!fs.existsSync(centralRepo)) {
                fs.mkdirSync(centralRepo, { recursive: true });
            }
        }
        
        return centralRepo;
    }
}
