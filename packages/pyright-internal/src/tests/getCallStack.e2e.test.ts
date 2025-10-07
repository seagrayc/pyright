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
// Temporarily disabling this test as it points to a non-existent local directory
// and causes the test runner to time out.
const reposToRun: number[] = [3];

/**
 * Finds the declaration for a method within a class in a given file.
 *
 * This function is a key part of the test setup, responsible for locating the precise
 * starting point for call stack analysis when the entrypoint is a class method.
 *
 * It operates in two main phases:
 * 1. AST Traversal to Find the Method Node: It uses a custom ParseTreeWalker (`MethodFinder`)
 *    to efficiently search the Abstract Syntax Tree (AST) of the specified file. The walker
 *    specifically looks for a class with `className` and then iterates through its methods
 *    to find one matching `methodName`. This is a targeted way to find the syntactic
 *    representation of the method in the source code.
 *
 * 2. Declaration Resolution: Once the `FunctionNode` for the method is found in the AST,
 *    this isn't enough to understand its full type information and connections in the
 *    broader program. The `DocumentSymbolCollector.getDeclarationsForNode` method is
 *    then used. This is a powerful pydantic/pyright feature that takes a parse node
 *    and resolves it to a `Declaration` object. The `Declaration` object is a much
 * "richer" representation that includes type information, the file URI, and the precise
 *    range of the declaration, making it suitable for deeper analysis like call hierarchy.
 *
 * A Note on the `.d.name.d.value` pattern:
 * This is a convention within Pyright's parser. The Abstract Syntax Tree (AST) nodes have a `.d`
 * property that holds the detailed data for that node (like its name, suite, etc.). The `name`
 * itself is another node, so to get its string value, the access pattern becomes
 * `node.d.name.d.value`. A new engineer would discover this by inspecting the type definitions
 * in `packages/pyright-internal/src/parser/parseNodes.ts`.
 *
 * @param program The pyright Program instance, which contains the ASTs and type information for the entire project.
 * @param file The URI of the file to search within.
 * @param className The name of the class containing the method.
 * @param methodName The name of the method to find.
 * @returns The `Declaration` for the method, or `undefined` if not found.
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

    // Use a ParseTreeWalker to visit nodes in the AST. This is more efficient than
    // manually traversing the entire tree.
    class MethodFinder extends ParseTreeWalker {
        // We only need to override the `visitClass` method.
        override visitClass(node: ClassNode): boolean {
            // Check if the class name matches the one we're looking for.
            if (node.d.name.d.value === className) {
                // If it matches, iterate through the statements in the class suite.
                for (const statement of node.d.suite.d.statements) {
                    // We're looking for a function statement with the correct name.
                    if (statement.nodeType === ParseNodeType.Function && statement.d.name.d.value === methodName) {
                        methodNode = statement;
                        // Once found, we can stop the walk.
                        return false;
                    }
                }
            }
            // If the class name doesn't match, or the method isn't in this class,
            // continue walking the tree.
            return true;
        }
    }

    // Instantiate and run the walker on the parse tree of the file.
    new MethodFinder().walk(parseResults.parserOutput.parseTree);

    if (!methodNode) {
        // If the walker didn't find the method, return undefined.
        return undefined;
    }

    // Now that we have the parse node for the function, we need to get its
    // corresponding Declaration. The Declaration provides richer semantic information.
    // `DocumentSymbolCollector` is a pyright utility that can resolve parse nodes
    // to their declarations.
    const decls = DocumentSymbolCollector.getDeclarationsForNode(program, methodNode.d.name, CancellationToken.None, {
        resolveLocalNames: true,
    });

    // It's possible for a node to have multiple declarations, but for a method
    // definition, we expect exactly one.
    // POTENTIAL BUG/LIMITATION: This walker only finds methods defined directly
    // in the class suite. It would not find methods defined dynamically or
    // nested within other statements (e.g., inside a conditional statement
    // in the class body), which is a rare but possible edge case.
    return decls.length > 0 ? decls[0] : undefined;
}

/**
 * Finds the declaration for a top-level function in a given file.
 *
 * This function is similar to `findMethodDeclaration` but is simpler as it operates
 * on top-level functions rather than methods within classes. It's used to find the
 * entrypoint for analysis when it's a simple function.
 *
 * The process is:
 * 1. Find the Function Node: It directly iterates over the top-level statements in the
 *    file's AST. This is a straightforward approach because top-level functions are
 *    direct children of the module node. It stops as soon as it finds a `FunctionNode`
 *    with a matching name.
 *
 * 2. Declaration Resolution: Just like in `findMethodDeclaration`, once the syntactic
 *    node is found, `DocumentSymbolCollector.getDeclarationsForNode` is used to resolve
 *    it into a full `Declaration` object, which contains the rich semantic information
 *    needed for the call stack analysis.
 *
 * @param program The pyright Program instance.
 * @param file The URI of the file to search.
 * @param functionName The name of the function to find.
 * @returns The `Declaration` for the function, or `undefined` if not found.
 */
function findFunctionDeclaration(program: Program, file: Uri, functionName: string): Declaration | undefined {
    const parseResults = program.getParseResults(file);
    if (!parseResults) {
        throw new Error(`Could not get parse results for ${file.toUserVisibleString()}`);
    }

    let functionNode: FunctionNode | undefined;

    // Iterate through the top-level statements of the parsed file.
    // This is simpler than a full walk because we assume the function is not nested
    // inside another structure (like a class or another function).
    for (const statement of parseResults.parserOutput.parseTree.d.statements) {
        if (statement.nodeType === ParseNodeType.Function && statement.d.name.d.value === functionName) {
            functionNode = statement;
            // Found it, no need to continue looping.
            break;
        }
    }

    if (!functionNode) {
        // If the loop completes without finding the function, return undefined.
        return undefined;
    }

    // Like in `findMethodDeclaration`, we resolve the found parse node into a
    // `Declaration` to get full semantic information.
    const decls = DocumentSymbolCollector.getDeclarationsForNode(program, functionNode.d.name, CancellationToken.None, {
        resolveLocalNames: true,
    });
    // POTENTIAL BUG/LIMITATION: This function only searches for top-level functions.
    // It will not find functions that are nested inside other functions or control
    // flow blocks. This is a reasonable simplification for finding a main entrypoint
    // but would fail for more complex scenarios.
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
 * Generates a virtual call stack for a given function declaration using a breadth-first search (BFS) traversal.
 *
 * This function is the core of the e2e test, simulating how a tool might analyze the call graph
 * starting from a specific function. It reveals the architecture of pyright's code intelligence features.
 *
 * Key Architectural Aspects Leveraged:
 * - **BFS for Traversal**: It uses a queue-based BFS to explore the call graph level by level. This is a standard
 *   way to explore graphs without getting lost in deep recursion.
 * - **`CallHierarchyProvider`**: For a given function declaration (`decl`), this provider is used to find all the
 *   "outgoing calls". This is the primary mechanism for discovering the next layer of the call graph. It tells us
 *   "what functions does this function call?".
 * - **`ReferencesProvider`**: When `CallHierarchyProvider` gives us a call site, we need to figure out what
 *   function is actually being called. `ReferencesProvider.getDeclarationForPosition` resolves the symbol at the
 *   call site to its `Declaration`. This is how we jump from a call to the callee's definition.
 * - **Alias Resolution**: Code often imports functions/classes, creating aliases. The logic explicitly checks if a
 *   declaration is an `Alias` and uses `program.evaluator.resolveAliasDeclaration` to find the *actual* source
 *   declaration. This is crucial for correctly tracing calls across module boundaries.
 * - **Domain-Specific Depth Limiting**: The function distinguishes between "my code" (within the `projectRoot`) and
 *   "not my code" (libraries, stdlib). It uses `myCodeMaxDepth` and `notMyCodeMaxDepth` to control how deep the
 *   traversal goes in each domain. This is a practical feature to prevent exploring the entire python stdlib.
 * - **Cycle/Recursion Detection**: It maintains a `visited` set to detect when a function is called again in the
 *   current path. This prevents infinite loops in recursive or co-recursive functions and allows the test
 *   output to explicitly label recursion.
 *
 * A Note on "My Code" vs. "Not My Code" (Libraries/Stdlib):
 * Pydantic/pyright differentiates between code sources to focus analysis. In this test, the distinction is made
 * using a simple and pragmatic heuristic: `isCalleeMyCode = calleeDecl.uri.startsWith(projectRoot)`.
 * If a file's path is within the project's root directory, it's "my code." Everything else, including
 * the standard library (stdlib) and third-party packages in `site-packages`, is "not my code."
 * This allows the traversal to have different depth limits for project code vs. library code, which is
 * a practical way to prevent exploring the entire dependency graph of every library. While this path-based
 * approach is a simplification for the test, Pyright's core analysis engine uses a more sophisticated
 * import resolution mechanism (`ImportResolver`) to accurately locate and differentiate these sources.
 *
 * @param program The pyright Program instance.
 * @param startDecl The starting `Declaration` for the traversal.
 * @param projectRoot The root URI of the user's project to distinguish "my code" from library code.
 * @param myCodeMaxDepth The maximum depth to trace within the user's code.
 * @param notMyCodeMaxDepth The maximum depth to trace within library code.
 * @returns A `CallStack` object representing the root of the call tree.
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

    // The queue for the BFS traversal. Each item contains the declaration to visit,
    // a reference to its parent node in the output `CallStack` tree, whether it's
    // considered "my code", and its current traversal depth within that domain.
    const queue: { decl: Declaration; callStackNode: CallStack; isMyCode: boolean; depth: number }[] = [];
    queue.push({ decl: startDecl, callStackNode: root, isMyCode: true, depth: 0 });

    // The visited set is crucial for performance and correctness. It prevents
    // re-processing the same function and is the mechanism for detecting recursion.
    // The key is a unique identifier for a declaration's location.
    const visited = new Set<string>();
    const startDeclKey = `${startDecl.uri.toUserVisibleString()}:${startDecl.range.start.line}:${
        startDecl.range.start.character
    }`;
    visited.add(startDeclKey);

    let head = 0;
    while (head < queue.length) {
        const { decl, callStackNode, isMyCode, depth } = queue[head++];

        // Apply domain-specific depth limits. This is the pruning step of the BFS.
        if (isMyCode && depth >= myCodeMaxDepth) {
            continue;
        }
        if (!isMyCode && depth >= notMyCodeMaxDepth) {
            continue;
        }

        // Use the CallHierarchyProvider to find all functions called by the current function.
        const provider = new CallHierarchyProvider(program, decl.uri, decl.range.start, CancellationToken.None);
        const outgoingCalls = provider.getOutgoingCalls();

        if (outgoingCalls) {
            for (const call of outgoingCalls) {
                // For each outgoing call, we need to find the declaration of the function being called.
                // This is a critical step that connects the call site to the callee's definition.
                const referencesResult = ReferencesProvider.getDeclarationForPosition(
                    program,
                    Uri.parse(call.to.uri, program.serviceProvider),
                    call.to.selectionRange.start,
                    undefined,
                    ReferenceUseCase.References,
                    CancellationToken.None
                );

                if (!referencesResult || referencesResult.declarations.length === 0) {
                    // Possible bug: This might happen if a symbol can't be resolved.
                    // For this test, we'll just skip it, but in a real tool, this might
                    // warrant a warning or a different representation in the call stack.
                    continue;
                }

                let calleeDecl = referencesResult.declarations[0];

                // Handle cases where the callee is an imported alias. We need to
                // resolve it to the original declaration to trace the call correctly.
                if (calleeDecl.type === DeclarationType.Alias) {
                    const resolved = program.evaluator?.resolveAliasDeclaration(calleeDecl, true);
                    if (resolved) {
                        calleeDecl = resolved;
                    }
                    // POTENTIAL BUG: If alias resolution fails (e.g., for a complex
                    // or partially typed library), `calleeDecl` remains the alias.
                    // The subsequent `isCalleeMyCode` check will be based on the location
                    // of the alias, not the actual code, which could lead to incorrect
                    // depth limiting.
                }

                // Determine if the called function is part of "my code" or a library.
                const isCalleeMyCode = calleeDecl.uri
                    .toUserVisibleString()
                    .startsWith(projectRoot.toUserVisibleString());

                let calleeName = getDeclarationName(calleeDecl);

                // Prepend a '*' to the name to signify a transition from user code to library code.
                // This is just for formatting the test output.
                if (isMyCode && !isCalleeMyCode) {
                    calleeName = `*${calleeName}`;
                }

                // Create a unique key for the callee declaration to check for cycles.
                const declKey = `${calleeDecl.uri.toUserVisibleString()}:${calleeDecl.range.start.line}:${
                    calleeDecl.range.start.character
                }`;

                // --- Cycle Detection ---
                if (visited.has(declKey)) {
                    // If we've already visited this function in this traversal path,
                    // we've found a recursive call. We add a special node to indicate this
                    // and do *not* add it to the queue to prevent an infinite loop.
                    const recursionNode: CallStack = {
                        declaration: calleeDecl,
                        name: `RECURSION to ${calleeName}`,
                        calls: [],
                    };
                    callStackNode.calls.push(recursionNode);
                    continue;
                }

                visited.add(declKey);

                // Create the new node for the call stack tree.
                const newCallStackNode: CallStack = {
                    declaration: calleeDecl,
                    name: calleeName,
                    calls: [],
                };
                callStackNode.calls.push(newCallStackNode);

                // The depth for the next level of the BFS.
                // It resets to 1 when we cross the boundary between "my code" and library code.
                const nextDepth = isMyCode === isCalleeMyCode ? depth + 1 : 1;

                // Add the callee to the queue to continue the traversal.
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

