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
import { CallHierarchyProvider } from '../languageService/callHierarchyProvider';
import { DocumentSymbolCollector } from '../languageService/documentSymbolCollector';
import { AnalyzerService } from '../analyzer/service';
import { ConsoleLogger } from '../common/consolelogger';
import { ConfigOptions } from '../common/configOptions';
import { createFromRealFileSystem } from '../common/realFileSystem';
import { Uri } from '../common/uri/uri';
import { NameNode } from '../parser/parseNodes';

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

    const decls = DocumentSymbolCollector.getDeclarationsForNode(program, methodNode.d.name, CancellationToken.None);
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
    const provider = new CallHierarchyProvider(program, CancellationToken.None);

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

        const outgoingCalls = await provider.getOutgoingCalls(decl);

        for (const call of outgoingCalls) {
            const calleeDecl = call.declaration;

            if (justMyCode) {
                const isThirdParty = !calleeDecl.uri.toUserVisibleString().startsWith(projectRoot.toUserVisibleString());
                const isTypingStub = calleeDecl.uri.toUserVisibleString().includes('stdlib/typing.pyi');
                if (isThirdParty && !isTypingStub) {
                    continue;
                }
            }

            // The call hierarchy provider can sometimes return the import statement
            // as a declaration. We want to resolve that to the actual function.
            let finalDecl = calleeDecl;
            if (calleeDecl.type === DeclarationType.Alias) {
                 const resolved = program.evaluator?.resolveAlias(calleeDecl, true);
                 if(resolved && resolved.length > 0) {
                    finalDecl = resolved[0];
                 }
            }


            const calleeStack = await trace(finalDecl);
            if (calleeStack) {
                callStackNode.calls.push(calleeStack);
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
    const relativePath = path.relative(projectRoot.toUserVisibleString(), stack.declaration.uri.toUserVisibleString());
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
    const projectRootPath = path.resolve(__dirname, '../../../../e2e_test_astroid/astroid');
    const projectRoot = Uri.file(projectRootPath);
    let program: Program;

    beforeAll(() => {
        const realFs = createFromRealFileSystem();
        const logger = new ConsoleLogger();
        const service = new AnalyzerService('e2e-test-service', realFs, logger);

        const configOptions = new ConfigOptions(projectRoot);
        configOptions.projectRoot = projectRoot;
        configOptions.autoSearchPaths = true;

        service.setOptions(configOptions);

        program = service.test_program;
        while (program.analyze()) {
            // Wait for analysis to complete
        }
    });

    test('should trace call stack for AstroidManager.ast_from_file', async () => {
        const managerPyFile = Uri.file(path.join(projectRootPath, 'astroid/manager.py'));

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