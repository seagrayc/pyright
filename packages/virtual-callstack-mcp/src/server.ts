import { ModelContextServer as Server, Tool } from '@modelcontextprotocol/sdk';
import { CancellationToken } from 'vscode-jsonrpc';
import {
    createFromRealFileSystem,
    RealTempFile,
} from 'pyright-internal/common/realFileSystem';
import { PyrightFileSystem } from 'pyright-internal/pyrightFileSystem';
import { createServiceProvider } from 'pyright-internal/common/serviceProviderExtensions';
import { StandardConsole } from 'pyright-internal/common/console';
import { AnalyzerService } from 'pyright-internal/analyzer/service';
import { CommandLineOptions } from 'pyright-internal/common/commandLineOptions';
import { Uri } from 'pyright-internal/common/uri/uri';
import { Program } from 'pyright-internal/analyzer/program';
import { ServiceProvider } from 'pyright-internal/common/serviceProvider';
import { Declaration, DeclarationType } from 'pyright-internal/analyzer/declaration';
import { ReferencesProvider } from 'pyright-internal/languageService/referencesProvider';
import { CallHierarchyProvider } from 'pyright-internal/languageService/callHierarchyProvider';
import { ParseNodeType } from 'pyright-internal/parser/parseNodes';
import { ReferenceUseCase } from 'pyright-internal/common/extensibility';

interface CallStack {
    declaration: Declaration;
    name: string;
    calls: CallStack[];
}

interface SerializableCallStack {
    name: string;
    filePath: string;
    range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    calls: SerializableCallStack[];
}

class PyrightServiceManager {
    private _serviceProvider: ServiceProvider | undefined;
    private _program: Program | undefined;
    public isInitialized = false;
    private _projectRoot: Uri | undefined;

    get program(): Program {
        if (!this._program) {
            throw new Error('Program is not initialized. Call initialize_project first.');
        }
        return this._program;
    }

    get serviceProvider(): ServiceProvider {
        if (!this._serviceProvider) {
            throw new Error('ServiceProvider is not initialized. Call initialize_project first.');
        }
        return this._serviceProvider;
    }

    get projectRoot(): Uri {
        if (!this._projectRoot) {
            throw new Error('Project root is not set. Call initialize_project first.');
        }
        return this._projectRoot;
    }

    async initialize_project(project_root: string): Promise<{ success: boolean; message?: string }> {
        try {
            const console = new StandardConsole();
            const tempFile = new RealTempFile();
            const fileSystem = new PyrightFileSystem(createFromRealFileSystem(tempFile, console));
            this._serviceProvider = createServiceProvider(fileSystem, console, tempFile);

            this._projectRoot = Uri.file(project_root, this._serviceProvider);

            const service = new AnalyzerService('virtual-callstack-mcp-service', this._serviceProvider, {
                console,
                fileSystem,
            });

            const analysisCompletePromise = new Promise<void>((resolve) => {
                service.setCompletionCallback(() => {
                    resolve();
                });
            });

            const commandLineOptions = new CommandLineOptions(this._projectRoot.toUserVisibleString(), false);
            commandLineOptions.configSettings.autoSearchPaths = true;

            service.setOptions(commandLineOptions);

            this._program = service.test_program;

            await analysisCompletePromise;
            this.isInitialized = true;
            return { success: true };
        } catch (error: any) {
            return { success: false, message: error.message };
        }
    }

    private _getDeclarationName(declaration: Declaration): string {
        const node = declaration.node;
        if (node.nodeType === ParseNodeType.Function) {
            return node.d.name.d.value;
        }
        if (node.nodeType === ParseNodeType.Class) {
            return node.d.name.d.value;
        }
        if (node.nodeType === ParseNodeType.Name) {
            return node.d.value;
        }
        return 'anonymous';
    }

    async get_call_stack(
        startDecl: Declaration,
        myCodeMaxDepth: number,
        notMyCodeMaxDepth: number
    ): Promise<SerializableCallStack> {
        const callStack = await this._get_call_stack_internal(startDecl, myCodeMaxDepth, notMyCodeMaxDepth);
        return this._serializeCallStack(callStack);
    }

    private async _get_call_stack_internal(
        startDecl: Declaration,
        myCodeMaxDepth: number,
        notMyCodeMaxDepth: number
    ): Promise<CallStack> {
        const root: CallStack = {
            declaration: startDecl,
            name: this._getDeclarationName(startDecl),
            calls: [],
        };

        const queue: { decl: Declaration; callStackNode: CallStack; isMyCode: boolean; depth: number }[] = [];
        queue.push({ decl: startDecl, callStackNode: root, isMyCode: true, depth: 0 });

        const visited = new Set<string>();
        const startDeclKey = `${startDecl.uri.toUserVisibleString()}:${startDecl.range.start.line}:${
            startDecl.range.start.character
        }`;
        visited.add(startDeclKey);

        let head = 0;
        while (head < queue.length) {
            const { decl, callStackNode, isMyCode, depth } = queue[head++];

            if ((isMyCode && depth >= myCodeMaxDepth) || (!isMyCode && depth >= notMyCodeMaxDepth)) {
                continue;
            }

            const provider = new CallHierarchyProvider(this.program, decl.uri, decl.range.start, CancellationToken.None);
            const outgoingCalls = provider.getOutgoingCalls();

            if (outgoingCalls) {
                for (const call of outgoingCalls) {
                    const referencesResult = ReferencesProvider.getDeclarationForPosition(
                        this.program,
                        Uri.parse(call.to.uri, this.serviceProvider),
                        call.to.selectionRange.start,
                        undefined,
                        ReferenceUseCase.References,
                        CancellationToken.None
                    );

                    if (!referencesResult || referencesResult.declarations.length === 0) {
                        continue;
                    }

                    let calleeDecl = referencesResult.declarations[0];

                    if (calleeDecl.type === DeclarationType.Alias) {
                        const resolved = this.program.evaluator?.resolveAliasDeclaration(calleeDecl, true);
                        if (resolved) {
                            calleeDecl = resolved;
                        }
                    }

                    const isCalleeMyCode = calleeDecl.uri
                        .toUserVisibleString()
                        .startsWith(this.projectRoot.toUserVisibleString());

                    let calleeName = this._getDeclarationName(calleeDecl);

                    if (isMyCode && !isCalleeMyCode) {
                        calleeName = `*${calleeName}`;
                    }

                    const declKey = `${calleeDecl.uri.toUserVisibleString()}:${calleeDecl.range.start.line}:${
                        calleeDecl.range.start.character
                    }`;

                    if (visited.has(declKey)) {
                        const recursionNode: CallStack = {
                            declaration: calleeDecl,
                            name: `RECURSION to ${calleeName}`,
                            calls: [],
                        };
                        callStackNode.calls.push(recursionNode);
                        continue;
                    }

                    visited.add(declKey);

                    const newCallStackNode: CallStack = {
                        declaration: calleeDecl,
                        name: calleeName,
                        calls: [],
                    };
                    callStackNode.calls.push(newCallStackNode);

                    const nextDepth = isMyCode === isCalleeMyCode ? depth + 1 : 1;

                    queue.push({
                        decl: calleeDecl,
                        callStackNode: newCallStackNode,
                        isMyCode: isCalleeMyCode,
                        depth: nextDepth,
                    });
                }
            }
        }

        return root;
    }

    private _serializeCallStack(stack: CallStack): SerializableCallStack {
        return {
            name: stack.name,
            filePath: stack.declaration.uri.toUserVisibleString(),
            range: stack.declaration.range,
            calls: stack.calls.map(c => this._serializeCallStack(c))
        };
    }
}

const pyrightServiceManager = new PyrightServiceManager();

const initializeProjectTool: Tool = {
    name: "initialize_project",
    description: "Initializes the Pyright service for a given project root. This must be called before any other tool.",
    run: async ({ project_root }: { project_root: string }) => {
        return await pyrightServiceManager.initialize_project(project_root);
    },
};

const getCallStackTool: Tool = {
    name: "get_call_stack",
    description: "Gets the virtual call stack for a function at a given file path and line number.",
    run: async ({ file_path, line_number, my_code_max_depth = 3, not_my_code_max_depth = 1 }: { file_path: string; line_number: number; my_code_max_depth?: number; not_my_code_max_depth?: number }) => {
        if (!pyrightServiceManager.isInitialized) {
            return { error: "Pyright service is not initialized. Please call initialize_project first." };
        }

        const fileUri = Uri.file(file_path, pyrightServiceManager.serviceProvider);
        const position = { line: line_number, character: 0 }; // Character can be 0, as we're interested in the line.

        const referencesResult = ReferencesProvider.getDeclarationForPosition(
            pyrightServiceManager.program,
            fileUri,
            position,
            undefined,
            ReferenceUseCase.References,
            CancellationToken.None
        );

        if (!referencesResult || referencesResult.declarations.length === 0) {
            return { error: `Could not find a declaration at ${file_path}:${line_number}` };
        }

        const startDecl = referencesResult.declarations[0];
        const callStack = await pyrightServiceManager.get_call_stack(startDecl, my_code_max_depth, not_my_code_max_depth);

        return callStack;
    },
};

const server = new Server({
    tools: [initializeProjectTool, getCallStackTool],
    port: 8000,
});

server.start();