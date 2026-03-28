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

        // 获取该订阅源的 skills
        const source = (element as any).source as Source;
        if (source) {
            const skills = this.sourceManager.getSkills(source.id);
            return skills.map(skill => {
                const isInstalled = this.installer.isInstalled(skill);
                const hasUpdate = isInstalled && this.installer.hasUpdate(skill);
                
                const item = new vscode.TreeItem(
                    skill.name,
                    vscode.TreeItemCollapsibleState.None
                );
                item.tooltip = skill.description || skill.name;
                item.description = skill.type === 'instruction' ? '(instruction)' : '';
                
                // 设置 contextValue 用于右键菜单
                if (hasUpdate) {
                    item.contextValue = 'skill-has-update';
                    item.iconPath = new vscode.ThemeIcon('sync');
                    item.description = '⬆ Update available';
                } else if (isInstalled) {
                    item.contextValue = 'skill-installed';
                    item.iconPath = new vscode.ThemeIcon('check');
                    item.description = 'Installed';
                } else {
                    item.contextValue = 'skill';
                    item.iconPath = new vscode.ThemeIcon('cloud-download');
                }
                
                (item as any).skill = skill;
                (item as any).source = source;
                return item;
            });
        }

        return [];
    }
}
