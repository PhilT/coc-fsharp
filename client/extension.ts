/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import { workspace, ExtensionContext, commands, StatusBarItem, TerminalResult } from 'coc.nvim';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'coc.nvim';
import { Range } from 'vscode-languageserver-protocol';
import {LanguageServerProvider, LanguageServerRepository, ILanguageServerPackages} from 'coc-utils'
import { REPLProvider } from 'coc-utils';
import {sleep, getCurrentSelection} from 'coc-utils';

function registerREPL(context: ExtensionContext, title: string) { 

    let replProvider = new REPLProvider({
        title: title,
        command: "dotnet",
        args: ['fsi', '--readline+', '--utf8output', '--nologo'],
        commit: ';;',
        filetype: 'fsharp'
    })

    let cmdEvalLine = commands.registerCommand("fsharp.evaluateLine", async () => await replProvider.eval('n'));
    let cmdEvalSelection = commands.registerCommand("fsharp.evaluateSelection", async () => await replProvider.eval('v'));
    let cmdExecFile = commands.registerCommand("fsharp.run", async (...args: any[]) => {
        let root = workspace.rootPath

        let argStrs = args
            ? args.map(x => `${x}`)
            : []

        let term = await workspace.createTerminal({
            name: `F# console`,
            shellPath: "dotnet",
            cwd: root,
            shellArgs: ['run'].concat(argStrs)
        })

        // switch to the terminal and steal focus
        term.show(false)
    })

    // Push the disposable to the context's subscriptions so that the 
    // client can be deactivated on extension deactivation
    // TODO push the repl provider
    context.subscriptions.push(cmdExecFile, cmdEvalLine, cmdEvalSelection);
}

export async function activate(context: ExtensionContext) {

    const cocfs_pkgs: ILanguageServerPackages = {
        "win-x64": {
            executable: "FSharpLanguageServer.exe",
            platformPath: "coc-fsharp-win10-x64.zip"
        },
        "linux-x64": {
            executable: "FSharpLanguageServer",
            platformPath: "coc-fsharp-linux-x64.zip"
        },
        "osx-x64": {
            executable: "FSharpLanguageServer",
            platformPath: "coc-fsharp-osx.10.11-x64.zip"
        }
    }

    const cocfs_repo: LanguageServerRepository = {
        kind: "github",
        repo: "coc-extensions/coc-fsharp",
        channel: "latest"
    }

    // The server is packaged as a standalone command
    const lsprovider = new LanguageServerProvider(context, "cocfs server", cocfs_pkgs, cocfs_repo)
    const languageServerExe = await lsprovider.getLanguageServer()

    let serverOptions: ServerOptions = { 
        command: languageServerExe, 
        args: [], 
        transport: TransportKind.stdio
    }

    // Options to control the language client
    let clientOptions: LanguageClientOptions = {
        // Register the server for F# documents
        documentSelector: [{scheme: 'file', language: 'fsharp'}],
        synchronize: {
            // Synchronize the setting section 'fsharp' to the server
            configurationSection: 'fsharp',
            // Notify the server about file changes to F# project files contain in the workspace
            fileEvents: [
                workspace.createFileSystemWatcher('**/*.fsproj'),
                workspace.createFileSystemWatcher('**/*.fs'),
                workspace.createFileSystemWatcher('**/*.fsi'),
                workspace.createFileSystemWatcher('**/*.fsx'),
                workspace.createFileSystemWatcher('**/project.assets.json')
            ]
        }
    }

    // Create the language client and start the client.
    let client = new LanguageClient('fsharp', 'F# Language Server', serverOptions, clientOptions);
    let disposable = client.start();

    // Push the disposable to the context's subscriptions so that the 
    // client can be deactivated on extension deactivation
    context.subscriptions.push(disposable);

    // When the language client activates, register a progress-listener
    client.onReady().then(() => createProgressListeners(client));

    // Register commands
    context.subscriptions.push(
        commands.registerCommand('fsharp.command.test.run', runTest),
        commands.registerCommand('fsharp.command.goto', goto),
        commands.registerCommand('fsharp.downloadLanguageServer', async () => {
            if (client.started) {
                await client.stop()
                disposable.dispose()
                await sleep(1000)
            }
            await lsprovider.downloadLanguageServer();
            disposable = client.start()
            context.subscriptions.push(disposable);
        }),
    )

    registerREPL(context, "F# REPL")
}

function goto(file: string, startLine: number, startColumn: number, _endLine: number, _endColumn: number) {
    let selection = Range.create(startLine, startColumn, startLine, startColumn);
    workspace.jumpTo(file, selection.start);
}

function runTest(projectPath: string, fullyQualifiedName: string): Thenable<TerminalResult> {
    let command = `dotnet test ${projectPath} --filter FullyQualifiedName=${fullyQualifiedName}`
    return workspace.runTerminalCommand(command);

    // !TODO parse the results coming back...
    //let kind: FSharpTestTask = {
    //type: 'fsharp.task.test',
    //projectPath: projectPath,
    //fullyQualifiedName: fullyQualifiedName
    //}
    //let task = workspace.createTask(`fsharp.task.test`);
    //let shell = new ShellExecution('dotnet', args)
    //let uri = Uri.file(projectPath)
    //let workspaceFolder = workspace.getWorkspaceFolder(uri.fsPath)
    //let task = new Task(kind, workspaceFolder, 'F# Test', 'F# Language Server', shell)
    //return tasks.executeTask(task)
}

interface StartProgress {
    title: string 
    nFiles: number
}

function createProgressListeners(client: LanguageClient) {
    // Create a "checking files" progress indicator
    let progressListener = new class {
        countChecked = 0
        nFiles = 0
        title: string = ""
        statusBarItem: StatusBarItem = null;

        startProgress(start: StartProgress) {
            // TODO implement user cancellation (???)
            this.title =  start.title
            this.nFiles = start.nFiles
            this.statusBarItem = workspace.createStatusBarItem(0, { progress : true });
            this.statusBarItem.text = this.title;
        }

        private percentComplete() {
            return Math.floor(this.countChecked / (this.nFiles + 1) * 100);
        }

        incrementProgress(fileName: string) {
            if (this.statusBarItem != null) {
                this.countChecked++;
                let newPercent = this.percentComplete();
                this.statusBarItem.text = `${this.title} (${newPercent}%)... [${fileName}]`
                this.statusBarItem.show();
            }
        }

        endProgress() {
            this.countChecked = 0
            this.nFiles = 0
            this.statusBarItem.hide()
            this.statusBarItem.dispose()
            this.statusBarItem = null
        }
    }

    // Use custom notifications to drive progressListener
    client.onNotification('fsharp/startProgress', (start: StartProgress) => {
        progressListener.startProgress(start);
    });
    client.onNotification('fsharp/incrementProgress', (fileName: string) => {
        progressListener.incrementProgress(fileName);
    });
    client.onNotification('fsharp/endProgress', () => {
        progressListener.endProgress();
    });
}

