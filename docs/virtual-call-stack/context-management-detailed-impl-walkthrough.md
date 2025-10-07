## 1. Comprehensive Scenarios for `get_call_stack`

`packages/pyright-internal/src/tests/getCallStack.e2e.test.ts` provides sufficient functionality for early testing - using this as the golden reference; if any requirements are contradicted in the docs; take the test source code as the final spec.

A robust `get_call_stack` implementation must handle a wide variety of real-world coding patterns. The goal is to produce a call graph that is both accurate and useful, filtering out noise while preserving essential context.

### Core Scenarios
*   **Direct Function Calls**: `func_a()` calls `func_b()`. This is the simplest case.
*   **Method Calls**: `obj.method_a()` calls `self.method_b()`.
*   **Class Instantiation**: `my_obj = MyClass()` should trace to the `MyClass.__init__` method.
*   **Inheritance**: A call to `child.method()` where `method` is defined on a parent class should resolve to the parent's implementation.
*   **Decorators**: A call to a decorated function should ideally trace to both the decorator and the original function.
*   **Dynamic Dispatch (Limited Support)**: For `obj.method()`, the tool should identify all possible implementations of `method` based on the declared type of `obj`. Fully dynamic calls at runtime are out of scope for static analysis.

### Advanced Scenarios & Edge Cases
*   **Function Aliasing**: `alias = my_func; alias()` should trace back to `my_func`.
*   **Higher-Order Functions**: A function passed as an argument and then called should be traced correctly.
*   **Lambdas and Closures**: Anonymous functions should be represented clearly in the call stack.
*   **Recursive Functions**: The call stack should handle recursion gracefully, likely by noting the recursive call without infinitely traversing it.
*   **Conditional Calls**: Calls inside `if/else` blocks, loops, and `try/except` blocks must all be identified. The tool should trace all possible paths.
*   **Module-Level Calls**: Functions called at the top level of a module.

### "Just My Code" Filtering
A crucial feature is the ability to distinguish between user-owned code and third-party library code. The `get_call_stack` function should support a `justMyCode` flag.

*   **Definition**: "My Code" is defined as the code within the project root being analyzed. "Library Code" is everything else (e.g., standard library, installed packages in `site-packages`).
*   **Implementation**: When `justMyCode` is `true`, the traversal should stop when it resolves to a file outside the project root. The call to the library function should be noted, but the traversal should not proceed further into the library's internal calls.

## 2. Existing Logic vs. Project Goals

While Pyright provides a powerful foundation, some of its components are not a perfect fit for building the `get_call_stack` tool as specified.

### `CallHierarchyProvider`
*   **Similarity**: This is the most similar existing feature. It is designed to find incoming and outgoing calls for a specific symbol, which is exactly what's needed for a single level of the call stack.
*   **Insufficiency**:
    *   **No Aggregation**: It doesn't aggregate these calls into a single, structured "call stack" data structure. The logic for recursively calling it and assembling the results would need to be built.
    *   **No `justMyCode` Concept**: It doesn't have a built-in notion of a project boundary for filtering. The filtering logic would need to be implemented on top of its results by checking the file path of each resolved call.

### `TypeEvaluator.getDeclInfoForNameNode`
*   **Similarity**: This is excellent for resolving a specific name node (like a function call) to its declaration. This is the core of reference resolution.
*   **Insufficiency**:
    *   **Too Low-Level**: Using `TypeEvaluator` directly requires manually walking the AST with a `ParseTreeWalker` to find all `CallNode` instances. This is verbose and reinvents the logic that `CallHierarchyProvider` already encapsulates.
    
### `DocumentSymbolCollector`
*   **Similarity**: Useful for finding declarations within a file.
*   **Insufficiency**: It is scoped to a single document and does not handle cross-file references or call relationships.

## 3. Working example E2E Test

For the self-contained E2E test, we will implement a simplified `get_call_stack` that combines these pieces.

1.  **Initialization**:
    *   Use `parseAndGetTestState` to set up a workspace and analyze the `e2e_test_astroid` project. This will give us access to a fully analyzed `program` object.

2.  **`get_call_stack` Function**:
    *   **Input**: Function name (e.g., `astroid.manager.AstroidManager.get_ast_from_proxy`) and a `justMyCode` flag.
    *   **Entry Point**:
        *   Find the `FunctionNode` for the entry point function.
        *   Use `DocumentSymbolCollector.getDeclarationsForNode` to get its `Declaration`.
    *   **Recursive Traversal Logic**:
        *   Create a recursive helper function, `_trace_calls(declaration, visited)`.
        *   **Base Case**: If a declaration has already been `visited`, return to avoid infinite loops.
        *   **Find Callees**:
            *   Instantiate `CallHierarchyProvider` for the current `declaration`.
            *   Use `getOutgoingCalls` to find all functions called by the current function.
        *   **Filter**:
            *   If `justMyCode` is true, discard any calls that resolve to files outside the `e2e_test_astroid` directory.
        *   **Recurse**: For each valid callee, recursively call `_trace_calls`.
        *   **Data Structure**: Build a tree or nested dictionary representing the call stack.

This approach leverages Pyright's high-level language service features (`CallHierarchyProvider`) while adding the necessary recursive traversal and filtering logic to meet the project's specific goals.