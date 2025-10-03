/*
 * codeMapBuilder.test.ts
 *
 * Test that sketches the high-level capabilities to leverage Pyright
 * for building a "map" of a codebase.
 */

import assert from 'assert';
import { CancellationToken } from 'vscode-jsonrpc';

import { Declaration, DeclarationType } from '../analyzer/declaration';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { isFunction } from '../analyzer/types';
import { CallNode, FunctionNode, ParseNodeType } from '../parser/parseNodes';
import { DocumentSymbolCollector } from '../languageService/documentSymbolCollector';
import { parseAndGetTestState } from './harness/fourslash/testState';

describe('CodeMapBuilder', () => {
    test('Sketch for building a codebase map', () => {
        const code = `
// @filename: main.py
//// import util
////
//// def main_func():
////     x = util.helper_func(1)
////     [|/*main_marker*/|]
////
//// class MainClass:
////     def method(self):
////         return "hello"

// @filename: util.py
//// def helper_func(param1: int) -> str:
////     return str(param1)
////     [|/*util_marker*/|]
        `;

        // 1. Initialize Project and Perform Analysis
        const state = parseAndGetTestState(code, '/project').state;
        const program = state.workspace.service.test_program;

        // Ensure analysis is complete
        while (program.analyze()) {
            // Continue analyzing until all files are processed
        }

        // 2. Accessing the Structural Foundation (ASTs and Symbols)
        const mainPyFile = state.getMarkerByName('main_marker').fileUri;
        const utilPyFile = state.getMarkerByName('util_marker').fileUri;

        const mainParseResults = program.getParseResults(mainPyFile);
        assert(mainParseResults, 'Should get parse results for main.py');
        const mainAst = mainParseResults.parserOutput.parseTree;
        assert(mainAst, 'AST for main.py should exist');

        const evaluator = program.evaluator;
        assert(evaluator, 'Evaluator should be available');

        // To get a specific declaration, we can find the node in the AST
        // and then get its associated declaration.
        const utilParseResults = program.getParseResults(utilPyFile);
        assert(utilParseResults, 'Should get parse results for util.py');
        const utilAst = utilParseResults.parserOutput.parseTree;

        let helperFuncNode: FunctionNode | undefined;
        class FuncFinder extends ParseTreeWalker {
            override visitFunction(node: FunctionNode): boolean {
                if (node.d.name.d.value === 'helper_func') {
                    helperFuncNode = node;
                }
                return false; // Don't walk deeper
            }
        }
        new FuncFinder().walk(utilAst);
        assert(helperFuncNode, 'Should find helper_func node');

        const helperFuncDecls = DocumentSymbolCollector.getDeclarationsForNode(program, helperFuncNode.d.name, CancellationToken.None);
        assert(helperFuncDecls.length > 0, 'Should get declarations for helper_func node');
        const helperFuncDecl = helperFuncDecls[0];

        assert.strictEqual(helperFuncDecl.type, DeclarationType.Function, 'helper_func should be a function declaration');
        assert.strictEqual(helperFuncDecl.uri.toUserVisibleString(), utilPyFile.toUserVisibleString());

        // 3. Accessing the Semantic Layer (Resolving References)
        class CallGraphWalker extends ParseTreeWalker {
            references = new Map<string, { decl: Declaration; callNode: CallNode }[]>();

            override visitCall(node: CallNode): boolean {
                if (node.d.leftExpr.nodeType === ParseNodeType.Name || node.d.leftExpr.nodeType === ParseNodeType.MemberAccess) {
                    const nameNode = node.d.leftExpr.nodeType === ParseNodeType.Name ?
                        node.d.leftExpr : node.d.leftExpr.d.member;

                    const decls = evaluator?.getDeclInfoForNameNode(nameNode)?.decls;
                    if (decls) {
                        const functionName = nameNode.d.value;
                        if (!this.references.has(functionName)) {
                            this.references.set(functionName, []);
                        }
                        decls.forEach(decl => {
                            this.references.get(functionName)!.push({ decl, callNode: node });
                        });
                    }
                }
                return super.visitCall(node);
            }
        }

        const walker = new CallGraphWalker();
        walker.walk(mainAst);

        // Verify that we found the call to 'helper_func' and resolved it
        const helperFuncRefs = walker.references.get('helper_func');
        assert(helperFuncRefs, "Should have found references for 'helper_func'");
        assert.strictEqual(helperFuncRefs.length, 1, "Should have one declaration for the 'helper_func' call");

        const resolvedDecl = helperFuncRefs[0].decl;
        assert.strictEqual(resolvedDecl.type, DeclarationType.Function);
        assert.strictEqual(resolvedDecl.uri.toUserVisibleString(), utilPyFile.toUserVisibleString(), "The call should resolve to util.py");

        // We can also get the type of the resolved symbol
        const typeOfHelperFunc = evaluator?.getTypeForDeclaration(resolvedDecl)?.type;
        assert(typeOfHelperFunc && isFunction(typeOfHelperFunc), 'Resolved symbol should be a function type');
    });
});