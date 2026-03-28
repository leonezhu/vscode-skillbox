import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SkillBoxProvider } from './providers/skillboxProvider';
import { SourceManager } from './managers/sourceManager';
import { SkillInstaller } from './services/installer';

export function activate(context: vscode.ExtensionContext) {
    console.log('SkillBox is now active!');

    const sourceManager = new SourceManager(context);
    const installer = new SkillInstaller(sourceManager, context);
    const skillBoxProvider = new SkillBoxProvider(sourceManager, installer);

    // Register Tree View
    const treeView = vscode.window.createTreeView('skillbox.sources', {
        treeDataProvider: skillBoxProvider,
        showCollapseAll: true
    });

    // Register Commands
    context.subscriptions.push(
        treeView,
        
        // Add Source
        vscode.commands.registerCommand('skillbox.addSource', async () => {
            const url = await vscode.window.showInputBox({
                prompt: 'Enter subscription source URL (GitHub or local path)',
                placeHolder: 'https://github.com/owner/skills-repo'
            });
            if (!url) {return;}

            const branch = await vscode.window.showInputBox({
                prompt: 'Branch name (leave empty for default branch)',
                placeHolder: 'main'
            });

            await sourceManager.addSource(url, branch || undefined);
            skillBoxProvider.refresh();
        }),

        // Refresh Sources
        vscode.commands.registerCommand('skillbox.refreshSources', async () => {
            const sources = sourceManager.getSources();
            if (sources.length === 0) {
                vscode.window.showInformationMessage('No sources to refresh');
                return;
            }
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Refreshing all sources...',
                cancellable: false
            }, async () => {
                for (const source of sources) {
                    await sourceManager.syncSource(source.id);
                }
            });
            skillBoxProvider.refresh();
        }),

        // Open Settings
        vscode.commands.registerCommand('skillbox.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'skillbox');
        }),

        // Sync Source
        vscode.commands.registerCommand('skillbox.syncSource', async (node) => {
            if (node?.source) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Syncing ${node.label}...`,
                    cancellable: false
                }, async () => {
                    await sourceManager.syncSource(node.source.id);
                });
                skillBoxProvider.refresh();
            }
        }),

        // Open Source
        vscode.commands.registerCommand('skillbox.openSource', async (node) => {
            if (node?.source) {
                const source = node.source;
                if (source.type === 'github') {
                    // 用浏览器打开 GitHub 仓库
                    const url = source.url.startsWith('git@') 
                        ? source.url.replace(/git@([^:]+):(.+)/, 'https://$1/$2').replace(/\.git$/, '')
                        : source.url.replace(/\.git$/, '');
                    vscode.env.openExternal(vscode.Uri.parse(url));
                } else {
                    // 用文件管理器打开本地路径
                    const sourcePath = sourceManager.getSourcePath(source.id);
                    if (fs.existsSync(sourcePath)) {
                        vscode.env.openExternal(vscode.Uri.file(sourcePath));
                    } else {
                        vscode.window.showErrorMessage(`Source path does not exist: ${sourcePath}`);
                    }
                }
            }
        }),

        // Remove Source
        vscode.commands.registerCommand('skillbox.removeSource', async (node) => {
            if (node?.source) {
                const confirm = await vscode.window.showWarningMessage(
                    `Remove source "${node.label}"?`,
                    'Yes', 'No'
                );
                if (confirm === 'Yes') {
                    await sourceManager.removeSource(node.source.id);
                    skillBoxProvider.refresh();
                }
            }
        }),

        // Install Skill
        vscode.commands.registerCommand('skillbox.installSkill', async (node) => {
            if (node?.skill) {
                await installer.install(node.skill);
                skillBoxProvider.refresh();
            }
        }),

        // Update Skill
        vscode.commands.registerCommand('skillbox.updateSkill', async (node) => {
            if (node?.skill) {
                await installer.update(node.skill);
                skillBoxProvider.refresh();
            }
        }),

        // Uninstall Skill
        vscode.commands.registerCommand('skillbox.uninstallSkill', async (node) => {
            if (node?.skill) {
                const confirm = await vscode.window.showWarningMessage(
                    `Uninstall ${node.skill.name}?`,
                    'Yes', 'No'
                );
                if (confirm === 'Yes') {
                    await installer.uninstall(node.skill);
                    skillBoxProvider.refresh();
                }
            }
        })
    );
}

export function deactivate() {}
