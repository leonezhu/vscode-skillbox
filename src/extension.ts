import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SkillBoxProvider } from './providers/skillboxProvider';
import { SourceManager } from './managers/sourceManager';
import { SkillInstaller } from './services/installer';
import { AgentType, InstallMethod, InstallScope, getAgentPaths, Skill } from './types';

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

    // Update title to show current agent
    const updateTitle = () => {
        const config = vscode.workspace.getConfiguration('skillbox');
        const agent = config.get<AgentType>('defaultAgent', 'copilot');
        treeView.title = getAgentPaths(agent).label;
    };
    updateTitle();

    // Listen for config changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('skillbox.defaultAgent')) {
                updateTitle();
                skillBoxProvider.refresh();
            }
        })
    );

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

        // Install All from Source
        vscode.commands.registerCommand('skillbox.installAllFromSource', async (node) => {
            if (node?.source) {
                const skills = sourceManager.getSkills(node.source.id);
                if (skills.length === 0) {
                    vscode.window.showWarningMessage('No resources found in this source');
                    return;
                }

                const config = vscode.workspace.getConfiguration('skillbox');
                const agent = config.get<AgentType>('defaultAgent', 'github-copilot');

                // Choose scope
                const projectPath = installer.getInstallPath(skills[0], agent, 'project');
                const globalPath = installer.getInstallPath(skills[0], agent, 'global');
                const scopeItems: vscode.QuickPickItem[] = [];
                if (projectPath) {
                    scopeItems.push({ label: 'Install to Project', description: getAgentPaths(agent).project });
                }
                if (globalPath) {
                    scopeItems.push({ label: 'Install to Global', description: getAgentPaths(agent).global });
                }
                if (scopeItems.length === 0) {
                    vscode.window.showErrorMessage('Please open a project folder first');
                    return;
                }
                const scopePicked = await vscode.window.showQuickPick(scopeItems, {
                    placeHolder: `Install all ${skills.length} resources from ${node.label}?`
                });
                if (!scopePicked) { return; }
                const scope: InstallScope = scopePicked.label.includes('Project') ? 'project' : 'global';

                // Choose method
                const methodItems: vscode.QuickPickItem[] = [
                    { label: 'Copy', description: 'Copy files to target location' },
                    { label: 'Symlink', description: 'Create symbolic link' }
                ];
                const methodPicked = await vscode.window.showQuickPick(methodItems, {
                    placeHolder: 'Installation method?'
                });
                if (!methodPicked) { return; }
                const method: InstallMethod = methodPicked.label.toLowerCase() as InstallMethod;

                // Check for already installed
                const toInstall: Skill[] = [];
                const alreadyInstalled: Skill[] = [];
                for (const skill of skills) {
                    const targetPath = installer.getInstallPath(skill, agent, scope);
                    if (targetPath && installer.isInstalled(skill)) {
                        alreadyInstalled.push(skill);
                    } else {
                        toInstall.push(skill);
                    }
                }

                if (alreadyInstalled.length > 0) {
                    const skip = await vscode.window.showWarningMessage(
                        `${alreadyInstalled.length} resources already installed. Overwrite?`,
                        'Overwrite All', 'Skip Existing', 'Cancel'
                    );
                    if (skip === 'Cancel') { return; }
                    if (skip === 'Skip Existing') {
                        // only install non-existing
                    } else {
                        // overwrite: add all
                        toInstall.push(...alreadyInstalled);
                    }
                }

                if (toInstall.length === 0) {
                    vscode.window.showInformationMessage('Nothing to install');
                    return;
                }

                const confirm = await vscode.window.showInformationMessage(
                    `Install ${toInstall.length} resources (${method})?`,
                    'Install', 'Cancel'
                );
                if (confirm !== 'Install') { return; }

                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Installing ${toInstall.length} resources...`,
                    cancellable: false
                }, async (progress) => {
                    let installed = 0;
                    for (const skill of toInstall) {
                        progress.report({ message: `[${++installed}/${toInstall.length}] ${skill.name}` });
                        const targetPath = installer.getInstallPath(skill, agent, scope);
                        if (targetPath) {
                            try {
                                await installer.installToPath(skill, targetPath, method);
                            } catch (e) {
                                console.error(`Failed to install ${skill.name}:`, e);
                            }
                        }
                    }
                });

                vscode.window.showInformationMessage(`Installed ${toInstall.length} resources from ${node.label}`);
                skillBoxProvider.refresh();
            }
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

        // View Skill File
        vscode.commands.registerCommand('skillbox.openSkillFile', async (node) => {
            if (node?.skill) {
                const skill = node.skill;
                const filePath = skill.type === 'skill'
                    ? path.join(skill.path, 'SKILL.md')
                    : skill.path;
                if (fs.existsSync(filePath)) {
                    const doc = await vscode.workspace.openTextDocument(filePath);
                    await vscode.window.showTextDocument(doc, { preview: true });
                } else {
                    vscode.window.showWarningMessage(`File not found: ${filePath}`);
                }
            }
        }),

        // Install Skill
        vscode.commands.registerCommand('skillbox.installSkill', async (node) => {
            if (node?.skill) {
                const skill = node.skill;
                const config = vscode.workspace.getConfiguration('skillbox');
                const agent = config.get<AgentType>('defaultAgent', 'copilot');
                
                // 计算项目路径和全局路径
                const workspaceFolders = vscode.workspace.workspaceFolders;
                const projectRoot = workspaceFolders?.[0]?.uri.fsPath;
                
                let projectPath: string | null = null;
                let globalPath: string | null = null;
                
                if (projectRoot) {
                    projectPath = installer.getInstallPath(skill, agent, 'project');
                }
                globalPath = installer.getInstallPath(skill, agent, 'global');
                
                // 构建选项列表
                const items: vscode.QuickPickItem[] = [];
                
                if (projectPath) {
                    const shortPath = projectRoot ? projectPath.replace(projectRoot, '.') : projectPath;
                    items.push({
                        label: 'Install to Project',
                        description: shortPath,
                        detail: projectPath
                    });
                }
                
                if (globalPath) {
                    const homeDir = process.env.HOME || '';
                    items.push({
                        label: 'Install to Global',
                        description: globalPath.startsWith(homeDir) ? globalPath.replace(homeDir, '~') : globalPath,
                        detail: globalPath
                    });
                }
                
                if (items.length === 0) {
                    vscode.window.showErrorMessage('Please open a project folder first');
                    return;
                }
                
                // 总是弹出选择器
                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: `Where to install "${skill.name}"?`
                });
                
                if (!picked) {return;}
                
                const targetPath = picked.detail!;
                
                // 选择安装方式
                const methodItems: vscode.QuickPickItem[] = [
                    { label: 'Copy', description: 'Copy files to target location' },
                    { label: 'Symlink', description: 'Create symbolic link' }
                ];
                const methodPicked = await vscode.window.showQuickPick(methodItems, {
                    placeHolder: 'Installation method?'
                });
                if (!methodPicked) {return;}
                
                const method: InstallMethod = methodPicked.label.toLowerCase() as InstallMethod;
                await installer.installToPath(skill, targetPath, method);
                skillBoxProvider.refresh();
            }
        }),

        // Update Skill
        vscode.commands.registerCommand('skillbox.updateSkill', async (node) => {
            if (node?.skill) {
                const skill = node.skill;
                const config = vscode.workspace.getConfiguration('skillbox');
                const agent = config.get<AgentType>('defaultAgent', 'copilot');

                const projectPath = installer.getProjectSkillPath(skill);
                
                if (projectPath) {
                    await installer.installToPath(skill, projectPath);
                } else {
                    // 没有项目路径，弹出选择器
                    const globalPath = installer.getInstallPath(skill, agent, 'global');
                    if (globalPath) {
                        await installer.installToPath(skill, globalPath);
                    }
                }
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
