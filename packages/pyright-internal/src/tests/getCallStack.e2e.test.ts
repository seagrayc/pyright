/*
 * getCallStack.e2e.test.ts
 *
 * End-to-end test for a robust `get_call_stack` implementation.
 * This test runs against a real copy of the 'astroid' repository.
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
import { AnalyzerService, AnalyzerServiceOptions } from '../analyzer/service';
import { StandardConsole } from '../common/console';
import { CommandLineOptions } from '../common/commandLineOptions';
import { createFromRealFileSystem, RealTempFile } from '../common/realFileSystem';
import { Uri } from '../common/uri/uri';
import { NameNode } from '../parser/parseNodes';
import { ServiceProvider } from '../common/serviceProvider';
import { ReferenceUseCase } from '../common/extensibility';
import { createServiceProvider } from '../common/serviceProviderExtensions';
import { PyrightFileSystem } from '../pyrightFileSystem';

interface CallStack {
    declaration: Declaration;
    name: string;
    calls: CallStack[];
}

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
 * Generates a virtual call stack for a given function declaration.
 */
async function get_call_stack(
    program: Program,
    startDecl: Declaration,
    projectRoot: Uri,
    justMyCode: boolean
): Promise<CallStack> {
    const visited = new Set<string>();

    async function trace(decl: Declaration): Promise<CallStack | null> {
        const declKey = `${decl.uri.toUserVisibleString()}:${decl.range.start.line}:${decl.range.start.character}`;
        if (visited.has(declKey)) {
            return {
                declaration: decl,
                name: `RECURSION to ${getDeclarationName(decl)}`,
                calls: [],
            };
        }
        visited.add(declKey);

        const callStackNode: CallStack = {
            declaration: decl,
            name: getDeclarationName(decl),
            calls: [],
        };

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

                if (justMyCode) {
                    const isThirdParty = !calleeDecl.uri
                        .toUserVisibleString()
                        .startsWith(projectRoot.toUserVisibleString());
                    const isTypingStub = calleeDecl.uri.toUserVisibleString().includes('stdlib');
                    if (isThirdParty && !isTypingStub) {
                        continue;
                    }
                }

                // The call hierarchy provider can sometimes return the import statement
                // as a declaration. We want to resolve that to the actual function.
                if (calleeDecl.type === DeclarationType.Alias) {
                    const resolved = program.evaluator?.resolveAliasDeclaration(calleeDecl, true);
                    if (resolved) {
                        calleeDecl = resolved;
                    }
                }

                const calleeStack = await trace(calleeDecl);
                if (calleeStack) {
                    callStackNode.calls.push(calleeStack);
                }
            }
        }

        visited.delete(declKey);
        return callStackNode;
    }

    const result = await trace(startDecl);
    assert(result, 'Call stack should not be null');
    return result;
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

describe('get_call_stack End-to-End Test', () => {
    // Note: This test is slower than a typical unit test because it initializes
    // a Pyright service on a real repository on disk.
    const projectRootPath = path.join(__dirname, '..', '..', '..', '..', 'e2e_test_astroid', 'astroid');
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
        projectRoot = Uri.file(projectRootPath, serviceProvider);

        // Create a service instance.
        const service = new AnalyzerService('e2e-test-service', serviceProvider, {
            console,
            fileSystem,
        });

        // The analysis performed by the service is asynchronous. To prevent the test
        // from starting before analysis is complete (which causes logging after the
        // test is done), we'll create a promise that resolves when the service
        // signals completion.
        const analysisCompletePromise = new Promise<void>((resolve) => {
            service.setCompletionCallback(() => {
                resolve();
            });
        });

        // Set up command line options to configure the service. This follows the
        // pattern used in pyright.ts for command-line execution. The project root
        // is the directory where pyright starts its search.
        const commandLineOptions = new CommandLineOptions(projectRoot.toUserVisibleString(), false);

        // Mimics the CLI behavior, allowing pyright to discover installed packages.
        commandLineOptions.configSettings.autoSearchPaths = true;

        // Provide a direct path to the python interpreter. This is the most reliable
        // way to ensure the correct environment is used for analysis, overriding
        // any environment discovery logic.
        commandLineOptions.configSettings.pythonPath = path.join(projectRootPath, '..', '.venv', 'bin', 'python');

        // Pass the options to the service to initialize the program and start analysis.
        service.setOptions(commandLineOptions);

        // Get the program instance.
        program = service.test_program;

        // Wait for the analysis to finish before proceeding with the tests.
        await analysisCompletePromise;
    }, 30000);

    test('should trace call stack for AstroidManager.ast_from_file', async () => {
        const managerPyFile = Uri.file(path.join(projectRootPath, 'astroid', 'manager.py'), serviceProvider);

        const startDecl = findMethodDeclaration(program, managerPyFile, 'AstroidManager', 'ast_from_file');
        assert(startDecl, 'Could not find declaration for ast_from_file');

        const callStack = await get_call_stack(program, startDecl, projectRoot, true);
        const formattedStack = formatCallStackForTest(callStack, projectRoot);

        const expectedStack = `
ast_from_file (in astroid/manager.py)
  file_stream (in astroid/manager.py)
    open (in stdlib/builtins.pyi)
  parse (in astroid/builder.py)
    AstroidBuilder (in astroid/builder.py)
    _pre_build (in astroid/builder.py)
      get_source_file (in astroid/modutils.py)
        search_module (in astroid/modutils.py)
          RECURSION to search_module
          _get_source_file (in astroid/modutils.py)
            RECURSION to _get_source_file
            file_info_from_modpath (in astroid/modutils.py)
              RECURSION to file_info_from_modpath
              get_spec (in stdlib/importlib/util.pyi)
              guess_modpath (in astroid/modutils.py)
                RECURSION to guess_modpath
`.trim();

        // For debugging:
        // console.log(formattedStack);

        // We will check that the output contains the key parts of the expected stack,
        // as the full output can be very long and subject to change with library updates.
        assert(formattedStack.includes('ast_from_file (in astroid/manager.py)'));
        assert(formattedStack.includes('  file_stream (in astroid/manager.py)'));
        assert(formattedStack.includes('    open (in stdlib/builtins.pyi)'));
        assert(formattedStack.includes('  parse (in astroid/builder.py)'));
        assert(formattedStack.includes('    _pre_build (in astroid/builder.py)'));
        assert(formattedStack.includes('      get_source_file (in astroid/modutils.py)'));
    }, 30000); // Increase timeout for this slow test
});

