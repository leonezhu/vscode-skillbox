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

    private _lastBackgroundSync = 0;
    private static SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    private _syncing = new Set<string>(); // track in-flight syncs
    private _manualSyncing = false;

    get syncingSet(): Set<string> { return this._syncing; }
    set manualSyncing(val: boolean) { this._manualSyncing = val; }

    private backgroundSyncAll(): void {
        if (this._manualSyncing) { return; }
        const now = Date.now();
        if (now - this._lastBackgroundSync < SkillBoxProvider.SYNC_INTERVAL_MS) { return; }
        this._lastBackgroundSync = now;

        const sources = this.sourceManager.getSources().filter(s => !this._syncing.has(s.id));
        if (sources.length === 0) { return; }

        // Fire-and-forget: sync in background, then refresh tree when done
        (async () => {
            try {
                for (const source of sources) {
                    this._syncing.add(source.id);
                    try {
                        await this.sourceManager.syncSourceSilent(source.id);
                    } finally {
                        this._syncing.delete(source.id);
                    }
                }
                this._onDidChangeTreeData.fire();
            } catch {
                // silent
            }
        })();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            // Auto-sync all sources in background on tree root expand
            this.backgroundSyncAll();
            return this.sourceManager.getSources().map(source => {
                const item = new vscode.TreeItem(
                    source.name,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                const branchInfo = source.branch ? ` (branch: ${source.branch})` : '';
                item.tooltip = `${source.url}${branchInfo}`;
                item.description = source.branch 
                    ? source.branch
                    : (source.lastSync 
                        ? `Last sync: ${new Date(source.lastSync).toLocaleString()}`
                        : 'Not synced');
                item.contextValue = 'source';
                item.iconPath = new vscode.ThemeIcon('folder');
                (item as any).source = source;
                return item;
            });
        }

        const skillType = (element as any).skillType;
        if (skillType) {
            const source = (element as any).source as Source;
            const skills = this.sourceManager.getSkills(source.id).filter(s => s.type === skillType);
            return this.buildSkillItems(skills, source);
        }

        const source = (element as any).source as Source;
        if (source) {
            const skills = this.sourceManager.getSkills(source.id);
            const grouped = this.groupByType(skills);

            if (Object.keys(grouped).length > 1) {
                const items: vscode.TreeItem[] = [];
                for (const [type, typeSkills] of Object.entries(grouped)) {
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

            return this.buildSkillItems(skills, source);
        }

        return [];
    }

    private async buildSkillItems(skills: Skill[], source: Source): Promise<vscode.TreeItem[]> {
        // Check update status for all installed skills in parallel
        const updateStatusMap = new Map<string, boolean>();
        const installed = skills.filter(s => this.installer.isInstalled(s));
        await Promise.all(installed.map(async s => {
            updateStatusMap.set(s.id, await this.installer.hasUpdate(s));
        }));

        return skills
            .sort((a, b) => {
                const aScore = updateStatusMap.get(a.id) ? -1 : this.installer.getInstallInfo(a) ? 0 : 1;
                const bScore = updateStatusMap.get(b.id) ? -1 : this.installer.getInstallInfo(b) ? 0 : 1;
                if (aScore !== bScore) { return aScore - bScore; }
                return a.name.localeCompare(b.name);
            })
            .map(skill => this.createSkillItem(skill, source, updateStatusMap.get(skill.id) || false));
    }

    private createSkillItem(skill: Skill, source: Source, hasUpdate: boolean): vscode.TreeItem {
        const installInfo = this.installer.getInstallInfo(skill);
        
        const item = new vscode.TreeItem(
            skill.name,
            vscode.TreeItemCollapsibleState.None
        );
        item.tooltip = skill.description || skill.name;
        
        if (hasUpdate) {
            item.contextValue = 'skill-has-update';
            item.iconPath = new vscode.ThemeIcon('arrow-up');
            const scopeLabel = installInfo!.scope === 'global' ? 'Global' : 'Project';
            item.description = `Update available (${scopeLabel})`;
        } else if (installInfo) {
            item.contextValue = 'skill-installed';
            item.iconPath = new vscode.ThemeIcon('check');
            const scopeLabel = installInfo.scope === 'global' ? 'Global' : 'Project';
            item.description = `Installed (${scopeLabel})`;
        } else {
            item.contextValue = 'skill';
            item.iconPath = new vscode.ThemeIcon('cloud-download');
            item.description = '';
        }
        
        (item as any).skill = skill;
        (item as any).source = source;
        return item;
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
}
