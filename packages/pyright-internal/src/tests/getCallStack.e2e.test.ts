/*
 * getCallStack.e2e.test.ts
 *
 * End-to-end test for a robust `get_call_stack` implementation.
 * This test runs against a real copy of the 'kvs' repository.
 */

import assert from 'assert';
import * as path from 'path';
import { CancellationToken } from 'vscode-jsonrpc';

import { Declaration, DeclarationType } from '../analyzer/declaration';
import { Program } from '../analyzer/program';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { ClassNode, FunctionNode, ParseNodeType } from '../parser/parseNodes';
import { ReferencesProvider } from '../languageService/referencesProvider';
import { CallHierarchyProvider } from '../languageService/callHierarchyProvider';
import { DocumentSymbolCollector } from '../languageService/documentSymbolCollector';
import { AnalyzerService } from '../analyzer/service';
import { StandardConsole } from '../common/console';
import { CommandLineOptions } from '../common/commandLineOptions';
import { createFromRealFileSystem, RealTempFile } from '../common/realFileSystem';
import { Uri } from '../common/uri/uri';
import { ServiceProvider } from '../common/serviceProvider';
import { ReferenceUseCase } from '../common/extensibility';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { PyrightFileSystem } from '../pyrightFileSystem';

interface CallStack {
    declaration: Declaration;
    name: string;
    calls: CallStack[];
}

interface TestScenario {
    description: string;
    myCodeMaxDepth: number;
    notMyCodeMaxDepth: number;
    expectedStack: string;
}

interface RepoTestConfig {
    name: string;
    path: string;
    pythonPath?: string;
    entrypoint: {
        file: string;
        type: 'function' | 'method';
        functionName: string;
        className?: string;
    };
    tests: TestScenario[];
}

// Array of repository configurations to test against.
const repoConfigs: RepoTestConfig[] = [
    {
        name: 'kvs',
        path: path.join(__dirname, '..', '..', '..', '..', 'e2e_test_kvs'),
        pythonPath: path.join(__dirname, '..', '..', '..', '..', '.venv', 'bin', 'python'),
        entrypoint: {
            file: 'main.py',
            type: 'function',
            functionName: 'main',
        },
        tests: [
            {
                description: 'with library calls shown but not explored',
                myCodeMaxDepth: 3,
                notMyCodeMaxDepth: 1,
                expectedStack: `
main (in main.py)
  KVS (in kvs.py)
    _load (in kvs.py)
      *json.load (in stdlib/json/__init__.pyi)
      *open (in stdlib/builtins.pyi)
  delete (in kvs.py)
    _save (in kvs.py)
      *json.dumps (in stdlib/json/__init__.pyi)
      *open (in stdlib/builtins.pyi)
    _validate_key (in kvs.py)
      *isinstance (in stdlib/builtins.pyi)
  get (in kvs.py)
    _validate_key (in kvs.py)
      *isinstance (in stdlib/builtins.pyi)
  *print (in stdlib/builtins.pyi)
  set (in kvs.py)
    _save (in kvs.py)
      *json.dumps (in stdlib/json/__init__.pyi)
      *open (in stdlib/builtins.pyi)
    _validate_key (in kvs.py)
      *isinstance (in stdlib/builtins.pyi)
`.trim(),
            },
        ],
    },
    {
        name: 'astroid',
        path: path.join(__dirname, '..', '..', '..', '..', 'e2e_test_astroid', 'astroid', 'astroid'),
        pythonPath: path.join(__dirname, '..', '..', '..', '..', '.venv', 'bin', 'python'),
        entrypoint: {
            file: 'manager.py',
            type: 'method',
            className: 'AstroidManager',
            functionName: 'ast_from_file',
        },
        tests: [
            {
                description: 'with library calls shown but not explored',
                myCodeMaxDepth: 4,
                notMyCodeMaxDepth: 1,
                expectedStack: ``.trim(),
            },
        ],
    },
    {
        name: 'kvs_lib',
        path: path.join(__dirname, '..', '..', '..', '..', 'e2e_test_kvs_lib'),
        pythonPath: path.join(__dirname, '..', '..', '..', '..', 'e2e_test_kvs_lib', '.venv', 'bin', 'python'),
        entrypoint: {
            file: 'src/main.py',
            type: 'function',
            functionName: 'start_server',
        },
        tests: [
            {
                description: 'with library calls shown but not explored',
                myCodeMaxDepth: 3,
                notMyCodeMaxDepth: 1,
                expectedStack: `
main (in main.py)
  KVS (in kvs.py)
    _load (in kvs.py)
      *json.load (in stdlib/json/__init__.pyi)
      *open (in stdlib/builtins.pyi)
  delete (in kvs.py)
    _save (in kvs.py)
      *json.dumps (in stdlib/json/__init__.pyi)
      *open (in stdlib/builtins.pyi)
    _validate_key (in kvs.py)
      *isinstance (in stdlib/builtins.pyi)
  get (in kvs.py)
    _validate_key (in kvs.py)
      *isinstance (in stdlib/builtins.pyi)
  *print (in stdlib/builtins.pyi)
  set (in kvs.py)
    _save (in kvs.py)
      *json.dumps (in stdlib/json/__init__.pyi)
      *open (in stdlib/builtins.pyi)
    _validate_key (in kvs.py)
      *isinstance (in stdlib/builtins.pyi)
`.trim(),
            },
        ],
    },    {
        name: 'openhands',
        path: path.join('/home/brent/repos/OpenHands'),
        pythonPath: path.join('/home/brent/.cache/pypoetry/virtualenvs/openhands-ai-kMiABEKe-py3.12/bin'),
        entrypoint: {
            file: 'openhands/core/main.py',
            type: 'function',
            functionName: 'run_main',
        },
        tests: [
            {
                description: 'with library calls shown but not explored',
                myCodeMaxDepth: 4,
                notMyCodeMaxDepth: 1,
                expectedStack: ``.trim(),
            },
        ],
    },
];

// Specify which repositories from the array to run tests on by their index.
const reposToRun: number[] = [3];

/**
 * Finds the declaration for a method within a class in a given file.
 */
function findMethodDeclaration(
    program: Program,
    file: Uri,
    className: string,
    methodName: string
): Declaration | undefined {
    const parseResults = program.getParseResults(file);
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
                        return false; // Stop walking
                    }
                }
            }
            return true; // Continue searching
        }
    }

    new MethodFinder().walk(parseResults.parserOutput.parseTree);

    if (!methodNode) {
        return undefined;
    }

    const decls = DocumentSymbolCollector.getDeclarationsForNode(program, methodNode.d.name, CancellationToken.None, {
        resolveLocalNames: true,
    });
    return decls.length > 0 ? decls[0] : undefined;
}

function findFunctionDeclaration(program: Program, file: Uri, functionName: string): Declaration | undefined {
    const parseResults = program.getParseResults(file);
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

    const decls = DocumentSymbolCollector.getDeclarationsForNode(program, functionNode.d.name, CancellationToken.None, {
        resolveLocalNames: true,
    });
    return decls.length > 0 ? decls[0] : undefined;
}

function getDeclarationName(declaration: Declaration): string {
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

/**
 * Generates a virtual call stack for a given function declaration using breadth-first search.
 */
async function get_call_stack(
    program: Program,
    startDecl: Declaration,
    projectRoot: Uri,
    myCodeMaxDepth: number,
    notMyCodeMaxDepth: number
): Promise<CallStack> {
    const root: CallStack = {
        declaration: startDecl,
        name: getDeclarationName(startDecl),
        calls: [],
    };

    // Queue for BFS traversal. Track if the declaration is part of "my code" and its depth within that domain.
    const queue: { decl: Declaration; callStackNode: CallStack; isMyCode: boolean; depth: number }[] = [];
    queue.push({ decl: startDecl, callStackNode: root, isMyCode: true, depth: 0 });

    // Visited set to prevent cycles and redundant work
    const visited = new Set<string>();
    const startDeclKey = `${startDecl.uri.toUserVisibleString()}:${startDecl.range.start.line}:${
        startDecl.range.start.character
    }`;
    visited.add(startDeclKey);

    let head = 0;
    while (head < queue.length) {
        const { decl, callStackNode, isMyCode, depth } = queue[head++];

        // Prune branches that exceed their respective depth limits.
        if (isMyCode && depth >= myCodeMaxDepth) {
            continue;
        }
        if (!isMyCode && depth >= notMyCodeMaxDepth) {
            continue;
        }

        const provider = new CallHierarchyProvider(program, decl.uri, decl.range.start, CancellationToken.None);
        const outgoingCalls = provider.getOutgoingCalls();

        if (outgoingCalls) {
            for (const call of outgoingCalls) {
                const referencesResult = ReferencesProvider.getDeclarationForPosition(
                    program,
                    Uri.parse(call.to.uri, program.serviceProvider),
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
                    const resolved = program.evaluator?.resolveAliasDeclaration(calleeDecl, true);
                    if (resolved) {
                        calleeDecl = resolved;
                    }
                }

                const isCalleeMyCode = calleeDecl.uri
                    .toUserVisibleString()
                    .startsWith(projectRoot.toUserVisibleString());

                let calleeName = getDeclarationName(calleeDecl);

                // Prepend '*' on the transition from user code to library code.
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

                // Reset depth on domain transition (my code <-> not my code)
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

function formatCallStackForTest(stack: CallStack, projectRoot: Uri, indent = ''): string {
    const relativePath = path.relative(
        projectRoot.toUserVisibleString(),
        stack.declaration.uri.toUserVisibleString()
    );
    let result = `${indent}${stack.name} (in ${relativePath})\n`;

    // Sort calls for deterministic output in tests
    const sortedCalls = stack.calls.sort((a, b) => a.name.localeCompare(b.name));

    for (const call of sortedCalls) {
        result += formatCallStackForTest(call, projectRoot, indent + '  ');
    }
    return result;
}

reposToRun.forEach((repoIndex) => {
    const config = repoConfigs[repoIndex];

    describe(`get_call_stack End-to-End Test for '${config.name}'`, () => {
        // Note: This test is slower than a typical unit test because it initializes
        // a Pyright service on a real repository on disk.
        let serviceProvider: ServiceProvider;
        let projectRoot: Uri;
        let program: Program;

        beforeAll(async () => {
            const console = new StandardConsole();
            const tempFile = new RealTempFile();

            // Follow pyright.ts pattern for creating the file system.
            const fileSystem = new PyrightFileSystem(createFromRealFileSystem(tempFile, console));

            // Use the helper to create a fully initialized service provider.
            serviceProvider = createServiceProvider(fileSystem, console, tempFile);

            // Now that the service provider is initialized, we can create URIs.
            projectRoot = Uri.file(config.path, serviceProvider);

            // Create a service instance.
            const service = new AnalyzerService('e2e-test-service', serviceProvider, {
                console,
                fileSystem,
            });

            // The analysis performed by the service is asynchronous.
            const analysisCompletePromise = new Promise<void>((resolve) => {
                service.setCompletionCallback(() => {
                    resolve();
                });
            });

            // Set up command line options to configure the service.
            const commandLineOptions = new CommandLineOptions(projectRoot.toUserVisibleString(), false);
            commandLineOptions.configSettings.autoSearchPaths = true;
            if (config.pythonPath) {
                commandLineOptions.configSettings.pythonPath = config.pythonPath;
            }

            // Pass the options to the service to initialize the program and start analysis.
            service.setOptions(commandLineOptions);

            // Get the program instance.
            program = service.test_program;

            // Wait for the analysis to finish before proceeding with the tests.
            await analysisCompletePromise;
        }, 30000);

        config.tests.forEach((testCase) => {
            test(`should trace call stack for ${config.entrypoint.functionName}() ${testCase.description}`, async () => {
                const entrypointFile = Uri.file(path.join(config.path, config.entrypoint.file), serviceProvider);
                let startDecl: Declaration | undefined;

                if (config.entrypoint.type === 'function') {
                    startDecl = findFunctionDeclaration(program, entrypointFile, config.entrypoint.functionName);
                } else {
                    assert(config.entrypoint.className, 'className must be provided for method entrypoint');
                    startDecl = findMethodDeclaration(
                        program,
                        entrypointFile,
                        config.entrypoint.className,
                        config.entrypoint.functionName
                    );
                }

                assert(startDecl, `Could not find declaration for ${config.entrypoint.functionName}`);

                // Call with an explicit max depth from config
                const callStack = await get_call_stack(
                    program,
                    startDecl,
                    projectRoot,
                    testCase.myCodeMaxDepth,
                    testCase.notMyCodeMaxDepth
                );
                const formattedStack = formatCallStackForTest(callStack, projectRoot);

                // For debugging purposes:
                // console.log(`---GENERATED STACK for ${config.name} ${testCase.description}---`);
                // console.log(formattedStack);
                // console.log(`---EXPECTED STACK for ${config.name}---`);
                // console.log(testCase.expectedStack);

                assert.strictEqual(formattedStack.trim(), testCase.expectedStack);
            }, 30000); // Increase timeout for this slow test
        });
    });
});

