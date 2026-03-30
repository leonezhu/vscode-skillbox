import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import simpleGit from 'simple-git';
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
            
            skillBoxProvider.manualSyncing = true;
            for (const source of sources) {
                skillBoxProvider.syncingSet.add(source.id);
                try { await sourceManager.syncSource(source.id); }
                finally { skillBoxProvider.syncingSet.delete(source.id); }
            }
            skillBoxProvider.manualSyncing = false;
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
                const workspaceFolders = vscode.workspace.workspaceFolders;
                const scopeItems: vscode.QuickPickItem[] = [];
                
                if (workspaceFolders && workspaceFolders.length > 0) {
                    if (workspaceFolders.length === 1) {
                        const projectRoot = workspaceFolders[0].uri.fsPath;
                        const projectPath = installer.getInstallPath(skills[0], agent, 'project', projectRoot);
                        if (projectPath) {
                            scopeItems.push({ label: 'Install to Project', description: getAgentPaths(agent).project });
                        }
                    } else {
                        for (const folder of workspaceFolders) {
                            const folderName = path.basename(folder.uri.fsPath);
                            scopeItems.push({ label: `$(folder) ${folderName}`, description: folder.uri.fsPath });
                        }
                    }
                }
                const globalPath = installer.getInstallPath(skills[0], agent, 'global');
                if (globalPath) {
                    scopeItems.push({ label: '$(home) Install to Global', description: getAgentPaths(agent).global });
                }
                if (scopeItems.length === 0) {
                    vscode.window.showErrorMessage('Please open a project folder first');
                    return;
                }
                const scopePicked = await vscode.window.showQuickPick(scopeItems, {
                    placeHolder: `Install all ${skills.length} resources from ${node.label}?`
                });
                if (!scopePicked) { return; }
                
                // Determine scope and project root
                let scope: InstallScope;
                let projectRoot: string | undefined;
                if (scopePicked.label.includes('Global')) {
                    scope = 'global';
                } else {
                    scope = 'project';
                    // If multiple folders, find the selected one
                    if (workspaceFolders && workspaceFolders.length > 1) {
                        const selectedName = scopePicked.label.replace('$(folder) ', '');
                        const selected = workspaceFolders.find(f => path.basename(f.uri.fsPath) === selectedName);
                        projectRoot = selected?.uri.fsPath;
                    } else {
                        projectRoot = workspaceFolders?.[0]?.uri.fsPath;
                    }
                }

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
                    const targetPath = installer.getInstallPath(skill, agent, scope, projectRoot);
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
                        const targetPath = installer.getInstallPath(skill, agent, scope, projectRoot);
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
                skillBoxProvider.manualSyncing = true;
                skillBoxProvider.syncingSet.add(node.source.id);
                try {
                    await sourceManager.syncSource(node.source.id);
                } finally {
                    skillBoxProvider.syncingSet.delete(node.source.id);
                }
                skillBoxProvider.manualSyncing = false;
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
                
                // If installed, open the installed version
                const installInfo = installer.getInstallInfo(skill);
                let filePath: string;
                if (installInfo) {
                    filePath = installInfo.targetPath;
                    if (skill.type === 'skill') {
                        filePath = path.join(filePath, 'SKILL.md');
                    }
                } else {
                    // Not installed, open from cache
                    filePath = skill.type === 'skill'
                        ? path.join(skill.path, 'SKILL.md')
                        : skill.path;
                }
                
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
                
                const workspaceFolders = vscode.workspace.workspaceFolders;
                
                // 构建选项列表
                const items: vscode.QuickPickItem[] = [];
                
                // 如果有多个 workspace folder，为每个添加选项
                if (workspaceFolders && workspaceFolders.length > 0) {
                    if (workspaceFolders.length === 1) {
                        // 单项目：直接用 "Install to Project"
                        const projectRoot = workspaceFolders[0].uri.fsPath;
                        const projectPath = installer.getInstallPath(skill, agent, 'project', projectRoot);
                        if (projectPath) {
                            items.push({
                                label: 'Install to Project',
                                description: projectPath.replace(projectRoot, '.'),
                                detail: projectPath
                            });
                        }
                    } else {
                        // 多项目：列出每个项目
                        for (const folder of workspaceFolders) {
                            const folderPath = folder.uri.fsPath;
                            const folderName = path.basename(folderPath);
                            const projectPath = installer.getInstallPath(skill, agent, 'project', folderPath);
                            if (projectPath) {
                                items.push({
                                    label: `$(folder) ${folderName}`,
                                    description: projectPath.replace(folderPath, '.'),
                                    detail: projectPath
                                });
                            }
                        }
                    }
                }
                
                // 全局安装选项
                const globalPath = installer.getInstallPath(skill, agent, 'global');
                if (globalPath) {
                    const homeDir = process.env.HOME || '';
                    items.push({
                        label: '$(home) Install to Global',
                        description: globalPath.startsWith(homeDir) ? globalPath.replace(homeDir, '~') : globalPath,
                        detail: globalPath
                    });
                }
                
                if (items.length === 0) {
                    vscode.window.showErrorMessage('Please open a project folder first');
                    return;
                }
                
                const picked = await vscode.window.showQuickPick(items, {
                    placeHolder: `Where to install "${skill.name}"?`
                });
                
                if (!picked) {return;}
                
                const targetPath = picked.detail!;
                
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
                await installer.update(node.skill);
                skillBoxProvider.refresh();
            }
        }),

        // View Update Diff
        vscode.commands.registerCommand('skillbox.viewUpdateDiff', async (node) => {
            if (node?.skill) {
                const skill = node.skill;
                const updateInfo = await installer.getUpdateInfo(skill);
                if (!updateInfo) {
                    vscode.window.showInformationMessage(`${skill.name} is already up to date`);
                    return;
                }

                const sourcePath = sourceManager.getSourcePath(skill.sourceId);
                if (!sourcePath) { return; }

                try {
                    const git = simpleGit(sourcePath);

                    const oldHash = updateInfo.oldHash;
                    const newHash = updateInfo.newHash;

                    if (skill.type === 'skill') {
                        const skillRelPath = path.relative(sourcePath, skill.path).replace(/\\/g, '/');
                        // Show diff for all changed files in this skill
                        const changedFiles = updateInfo.changedFiles;
                        // Pick the first changed file to show in diff view
                        const mainFile = changedFiles.find(f => f.endsWith('/SKILL.md')) || changedFiles[0];
                        if (!mainFile) {
                            vscode.window.showInformationMessage('No file changes to display');
                            return;
                        }
                        const oldContent = await git.show([`${oldHash}:${mainFile}`]);
                        const newContent = await git.show([`${newHash}:${mainFile}`]);

                        const oldTmp = path.join(os.tmpdir(), `skillbox-${skill.name}-${path.basename(mainFile)}-${oldHash.slice(0, 7)}`);
                        const newTmp = path.join(os.tmpdir(), `skillbox-${skill.name}-${path.basename(mainFile)}-${newHash.slice(0, 7)}`);
                        fs.writeFileSync(oldTmp, oldContent);
                        fs.writeFileSync(newTmp, newContent);

                        const suffix = changedFiles.length > 1 ? ` (${changedFiles.length} files changed)` : '';
                        await vscode.commands.executeCommand(
                            'vscode.diff',
                            vscode.Uri.file(oldTmp),
                            vscode.Uri.file(newTmp),
                            `${skill.name} (${oldHash.slice(0, 7)} → ${newHash.slice(0, 7)})${suffix}`
                        );
                    } else {
                        const relPath = path.relative(sourcePath, skill.path).replace(/\\/g, '/');
                        const oldContent = await git.show([`${oldHash}:${relPath}`]);
                        const newContent = await git.show([`${newHash}:${relPath}`]);

                        const ext = path.extname(skill.name) || '.md';
                        const oldTmp = path.join(os.tmpdir(), `skillbox-${skill.name}-old-${updateInfo.oldHash.slice(0, 7)}${ext}`);
                        const newTmp = path.join(os.tmpdir(), `skillbox-${skill.name}-new-${updateInfo.newHash.slice(0, 7)}${ext}`);
                        fs.writeFileSync(oldTmp, oldContent);
                        fs.writeFileSync(newTmp, newContent);

                        await vscode.commands.executeCommand(
                            'vscode.diff',
                            vscode.Uri.file(oldTmp),
                            vscode.Uri.file(newTmp),
                            `${skill.name} (${updateInfo.oldHash.slice(0, 7)} → ${updateInfo.newHash.slice(0, 7)})`
                        );
                    }
                } catch (e) {
                    vscode.window.showErrorMessage(`Failed to view diff: ${e}`);
                }
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
