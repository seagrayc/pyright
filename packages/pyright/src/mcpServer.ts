import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as path from 'path';
import { Declaration, DeclarationType } from 'pyright-internal/analyzer/declaration';
import { ParseTreeWalker } from 'pyright-internal/analyzer/parseTreeWalker';
import { Program } from 'pyright-internal/analyzer/program';
import { AnalyzerService } from 'pyright-internal/analyzer/service';
import { CommandLineOptions } from 'pyright-internal/common/commandLineOptions';
import { StandardConsole } from 'pyright-internal/common/console';
import { ReferenceUseCase } from 'pyright-internal/common/extensibility';
import {
    createFromRealFileSystem,
    RealTempFile,
} from 'pyright-internal/common/realFileSystem';
import { ServiceProvider } from 'pyright-internal/common/serviceProvider';
import { createServiceProvider } from 'pyright-internal/common/serviceProviderExtensions';
import { Uri } from 'pyright-internal/common/uri/uri';
import { CallHierarchyProvider } from 'pyright-internal/languageService/callHierarchyProvider';
import { DocumentSymbolCollector } from 'pyright-internal/languageService/documentSymbolCollector';
import { ReferencesProvider } from 'pyright-internal/languageService/referencesProvider';
import { ClassNode, FunctionNode, ParseNodeType } from 'pyright-internal/parser/parseNodes';
import { PyrightFileSystem } from 'pyright-internal/pyrightFileSystem';
import { CancellationToken } from 'vscode-jsonrpc';

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

    async initialize_project(project_root: string, pythonPath?: string): Promise<{ success: boolean; message?: string }> {
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
            if (pythonPath) {
                commandLineOptions.configSettings.pythonPath = pythonPath;
            }

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

    // Locate the declaration for a method inside a class within the given file
    public findMethodDeclaration(file: Uri, className: string, methodName: string): Declaration | undefined {
        const parseResults = this.program.getParseResults(file);
        if (!parseResults) {
            throw new Error(`Could not get parse results for ${file.toUserVisibleString()}`);
        }

        let methodNode: FunctionNode | undefined;

        class MethodFinder extends ParseTreeWalker {
            override visitClass(node: ClassNode): boolean {
                if (node.d.name.d.value === className) {
                    for (const statement of node.d.suite.d.statements) {
                        if (statement.nodeType === ParseNodeType.Function && statement.d.name.d.value === methodName) {
                            methodNode = statement;
                            return false;
                        }
                    }
                }
                return true;
            }
        }

        new MethodFinder().walk(parseResults.parserOutput.parseTree);

        if (!methodNode) {
            return undefined;
        }

        const decls = DocumentSymbolCollector.getDeclarationsForNode(
            this.program,
            methodNode.d.name,
            CancellationToken.None,
            { resolveLocalNames: true }
        );
        return decls.length > 0 ? decls[0] : undefined;
    }

    // Locate the declaration for a top-level function in the given file
    public findFunctionDeclaration(file: Uri, functionName: string): Declaration | undefined {
        const parseResults = this.program.getParseResults(file);
        if (!parseResults) {
            throw new Error(`Could not get parse results for ${file.toUserVisibleString()}`);
        }

        let functionNode: FunctionNode | undefined;
        for (const statement of parseResults.parserOutput.parseTree.d.statements) {
            if (statement.nodeType === ParseNodeType.Function && statement.d.name.d.value === functionName) {
                functionNode = statement;
                break;
            }
        }

        if (!functionNode) {
            return undefined;
        }

        const decls = DocumentSymbolCollector.getDeclarationsForNode(
            this.program,
            functionNode.d.name,
            CancellationToken.None,
            { resolveLocalNames: true }
        );
        return decls.length > 0 ? decls[0] : undefined;
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

const server = new Server(
    {
        name: "em/virtual-callstack",
        title: "Agentic Code Analysis",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Provide tool metadata to clients
server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [
        {
            name: "initialize_project",
            description:
                "Initializes the Pyright service for a given project root. This must be called before any other tool.",
            inputSchema: {
                type: "object",
                properties: {
                    project_root: { type: "string", description: "Absolute path to the Python project root" },
                    python_path: { type: "string", description: "Optional path to the Python interpreter to use" },
                },
                required: ["project_root"],
            } as any,
        },
        {
            name: "get_call_stack",
            description:
                "Gets the virtual call stack starting from an entrypoint (function or method).",
            inputSchema: {
                type: "object",
                properties: {
                    entrypoint: {
                        type: "object",
                        description: "Entrypoint descriptor for the analysis",
                        properties: {
                            file: { type: "string", description: "Path to file relative to project root or absolute" },
                            type: { type: "string", enum: ["function", "method"], description: "Entrypoint kind" },
                            functionName: { type: "string", description: "Function/method name" },
                            className: { type: "string", description: "Class name (required for methods)" },
                        },
                        required: ["file", "type", "functionName"],
                    },
                    my_code_max_depth: {
                        type: "integer",
                        default: 3,
                        description: "Max traversal depth within the user's codebase",
                    },
                    not_my_code_max_depth: {
                        type: "integer",
                        default: 1,
                        description: "Max traversal depth when stepping into external code",
                    },
                },
                required: ["entrypoint"],
            } as any,
        },
    ];

    return { tools };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params as any;

    if (name === "initialize_project") {
        const project_root = typeof args?.project_root === "string" ? args.project_root : undefined;
        const python_path = typeof args?.python_path === "string" ? args.python_path : undefined;
        if (!project_root) {
            throw new Error("'project_root' is required and must be a string");
        }
        const result = await pyrightServiceManager.initialize_project(project_root, python_path);
        return {
            content: [
                {
                    type: "text",
                    text: result.success ? "Initialization successful" : `Initialization failed: ${result.message ?? "unknown error"}`,
                },
            ],
        };
    }

    if (name === "get_call_stack") {
        if (!pyrightServiceManager.isInitialized) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Pyright service is not initialized. Please call initialize_project first.",
                    },
                ],
            };
        }

        const entrypoint = args?.entrypoint as any;
        const my_code_max_depth = Number.isInteger(args?.my_code_max_depth) ? (args.my_code_max_depth as number) : 3;
        const not_my_code_max_depth = Number.isInteger(args?.not_my_code_max_depth)
            ? (args.not_my_code_max_depth as number)
            : 1;

        if (!entrypoint || typeof entrypoint !== 'object') {
            throw new Error("'entrypoint' is required and must be an object");
        }

        const fileField = typeof entrypoint.file === 'string' ? (entrypoint.file as string) : undefined;
        const typeField = typeof entrypoint.type === 'string' ? (entrypoint.type as string) : undefined;
        const functionNameField = typeof entrypoint.functionName === 'string' ? (entrypoint.functionName as string) : undefined;
        const classNameField = typeof entrypoint.className === 'string' ? (entrypoint.className as string) : undefined;

        if (!fileField || !typeField || !functionNameField) {
            throw new Error("'entrypoint.file', 'entrypoint.type', and 'entrypoint.functionName' are required");
        }

        const projectRootPath = pyrightServiceManager.projectRoot.toUserVisibleString();
        const absPath = path.isAbsolute(fileField) ? fileField : path.join(projectRootPath, fileField);
        const entrypointFile = Uri.file(absPath, pyrightServiceManager.serviceProvider);

        let startDecl: Declaration | undefined;
        if (typeField === 'function') {
            startDecl = pyrightServiceManager.findFunctionDeclaration(entrypointFile, functionNameField);
        } else if (typeField === 'method') {
            if (!classNameField) {
                throw new Error("'entrypoint.className' is required when type is 'method'");
            }
            startDecl = pyrightServiceManager.findMethodDeclaration(entrypointFile, classNameField, functionNameField);
        } else {
            throw new Error("'entrypoint.type' must be either 'function' or 'method'");
        }

        if (!startDecl) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Could not find declaration for ${typeField === 'method' ? `${classNameField}.` : ''}${functionNameField} in ${absPath}`,
                    },
                ],
            };
        }
        const callStack = await pyrightServiceManager.get_call_stack(
            startDecl,
            my_code_max_depth,
            not_my_code_max_depth
        );

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(callStack),
                },
            ],
            structuredContent: callStack as any,
        };
    }

    throw new Error(`Unknown tool: ${name}`);
});

export const createServer = () => server;