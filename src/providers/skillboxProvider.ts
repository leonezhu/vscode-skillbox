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
                item.tooltip = source.url;
                item.description = source.lastSync 
                    ? `最后同步: ${new Date(source.lastSync).toLocaleString()}`
                    : '未同步';
                item.contextValue = 'source';
                item.iconPath = new vscode.ThemeIcon('folder');
                (item as any).source = source;
                return item;
            });
        }

        // 获取该订阅源的 skills
        const source = (element as any).source as Source;
        if (source) {
            const skills = this.sourceManager.getSkills(source.id);
            return skills.map(skill => {
                const isInstalled = this.installer.isInstalled(skill);
                const item = new vscode.TreeItem(
                    skill.name,
                    vscode.TreeItemCollapsibleState.None
                );
                item.tooltip = skill.description;
                item.description = skill.type === 'instruction' ? '(instruction)' : '';
                item.contextValue = isInstalled ? 'skill-installed' : 'skill';
                item.iconPath = new vscode.ThemeIcon(
                    isInstalled ? 'check' : 'cloud-download'
                );
                (item as any).skill = skill;
                (item as any).source = source;
                return item;
            });
        }

        return [];
    }
}
