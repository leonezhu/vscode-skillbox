import * as vscode from 'vscode';
import { SourceManager } from '../managers/sourceManager';
import { SkillInstaller } from '../services/installer';
import { Source, Skill } from '../types';

export class SkillBoxProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(
        private sourceManager: SourceManager,
        private installer: SkillInstaller
    ) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            // 根级别 - 显示所有订阅源
            return this.sourceManager.getSources().map(source => {
                const item = new vscode.TreeItem(
                    source.name,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                const branchInfo = source.branch ? ` (branch: ${source.branch})` : '';
                item.tooltip = `${source.url}${branchInfo}`;
                item.description = source.branch 
                    ? `branch: ${source.branch}`
                    : (source.lastSync 
                        ? `Last sync: ${new Date(source.lastSync).toLocaleString()}`
                        : 'Not synced');
                item.contextValue = 'source';
                item.iconPath = new vscode.ThemeIcon('folder');
                (item as any).source = source;
                return item;
            });
        }

        // 先检查是否是类型分组节点
        const skillType = (element as any).skillType;
        if (skillType) {
            const source = (element as any).source as Source;
            const skills = this.sourceManager.getSkills(source.id).filter(s => s.type === skillType);
            return skills
                .sort((a, b) => {
                    const aInstalled = this.installer.isInstalled(a) ? 0 : 1;
                    const bInstalled = this.installer.isInstalled(b) ? 0 : 1;
                    if (aInstalled !== bInstalled) {return aInstalled - bInstalled;}
                    return a.name.localeCompare(b.name);
                })
                .map(skill => this.createSkillItem(skill, source));
        }

        // 获取该订阅源的 skills
        const source = (element as any).source as Source;
        if (source) {
            const skills = this.sourceManager.getSkills(source.id);
            
            // 按类型分组
            const grouped = this.groupByType(skills);
            
            // 如果有多种类型，显示分组
            if (Object.keys(grouped).length > 1) {
                const items: vscode.TreeItem[] = [];
                
                for (const [type, typeSkills] of Object.entries(grouped)) {
                    // 添加类型分组节点
                    const typeItem = new vscode.TreeItem(
                        this.getTypeLabel(type),
                        vscode.TreeItemCollapsibleState.Collapsed
                    );
                    typeItem.iconPath = new vscode.ThemeIcon(this.getTypeIcon(type));
                    typeItem.description = `(${typeSkills.length})`;
                    (typeItem as any).source = source;
                    (typeItem as any).skillType = type;
                    items.push(typeItem);
                }
                
                return items;
            }
            
            // 按类型分组，已安装的排在前面
            return skills
                .sort((a, b) => {
                    const aInstalled = this.installer.isInstalled(a) ? 0 : 1;
                    const bInstalled = this.installer.isInstalled(b) ? 0 : 1;
                    if (aInstalled !== bInstalled) {return aInstalled - bInstalled;}
                    return a.name.localeCompare(b.name);
                })
                .map(skill => this.createSkillItem(skill, source));
        }

        return [];
    }

    private groupByType(skills: Skill[]): Record<string, Skill[]> {
        const grouped: Record<string, Skill[]> = {};
        for (const skill of skills) {
            if (!grouped[skill.type]) {
                grouped[skill.type] = [];
            }
            grouped[skill.type].push(skill);
        }
        return grouped;
    }

    private getTypeLabel(type: string): string {
        const labels: Record<string, string> = {
            'skill': 'Skills',
            'instruction': 'Instructions',
            'agent': 'Agents',
            'special': 'Special Files'
        };
        return labels[type] || type;
    }

    private getTypeIcon(type: string): string {
        const icons: Record<string, string> = {
            'skill': 'package',
            'instruction': 'book',
            'agent': 'hubot',
            'special': 'star'
        };
        return icons[type] || 'file';
    }

    private createSkillItem(skill: Skill, source: Source): vscode.TreeItem {
        const isInstalled = this.installer.isInstalled(skill);
        
        const item = new vscode.TreeItem(
            skill.name,
            vscode.TreeItemCollapsibleState.None
        );
        item.tooltip = skill.description || skill.name;
        
        // 设置 contextValue 用于右键菜单
        if (isInstalled) {
            item.contextValue = 'skill-installed';
            item.iconPath = new vscode.ThemeIcon('check');
            item.description = 'Installed';
        } else {
            item.contextValue = 'skill';
            item.iconPath = new vscode.ThemeIcon('cloud-download');
            item.description = '';
        }
        
        (item as any).skill = skill;
        (item as any).source = source;
        return item;
    }
}
