# A Journey Through Modern Static Analysis: From Go to Python & TypeScript

This document synthesizes a conversation about static type checking, tracing the path from high-level concepts to detailed implementation strategies in Pyright.

## 2. A Tale of Two Type Checkers: Pyright vs. tsc

While Pyright (for Python) and the TypeScript Compiler (tsc) serve similar goals, their implementations reveal different philosophies.

### Architectural Parallels

At a high level, both tools follow a classic compiler pipeline:

*   **Parsing**: Source code is converted into an Abstract Syntax Tree (AST).
    *   *Implementation*: [`packages/pyright-internal/src/parser/`](../packages/pyright-internal/src/parser/)
    *   *Tests*: [`packages/pyright-internal/src/tests/parser.test.ts`](../packages/pyright-internal/src/tests/parser.test.ts)
*   **Binding**: A "binder" traverses the AST to create symbols for every identifier.
    *   *Implementation*: [`packages/pyright-internal/src/analyzer/binder.ts`](../packages/pyright-internal/src/analyzer/binder.ts)
    *   *Tests*: [`packages/pyright-internal/src/tests/checker.test.ts`](../packages/pyright-internal/src/tests/checker.test.ts) (Binder logic is tested as part of the checker)
*   **Checking**: A "type checker" uses the AST and symbols to validate the code's type correctness.
    *   *Implementation*: [`packages/pyright-internal/src/analyzer/checker.ts`](../packages/pyright-internal/src/analyzer/checker.ts)
    *   *Tests*: [`packages/pyright-internal/src/tests/checker.test.ts`](../packages/pyright-internal/src/tests/checker.test.ts)
*   **LSP Integration**: Both are designed to function as language servers.
    *   *Implementation*: [`packages/pyright-internal/src/languageServerBase.ts`](../packages/pyright-internal/src/languageServerBase.ts)
    *   *Tests*: [`packages/pyright-internal/src/tests/languageServer.test.ts`](../packages/pyright-internal/src/tests/languageServer.test.ts)

### Core Implementation Differences

A key takeaway is Pyright's focus on speed, achieved by its TypeScript implementation and a "lazy" evaluation strategy optimized for fast, incremental checks in an IDE.

## 3. The Practicality of Gradual Typing in Python

Pyright evaluates unannotated symbols through **Type Inference**.

*   **Inference from Assignment**: Pyright infers a variable's type from the value it's assigned.
*   **Control Flow Analysis**: It intelligently "narrows" types within conditional blocks.
    *   *Implementation*: [`packages/pyright-internal/src/analyzer/codeFlowEngine.ts`](../packages/pyright-internal/src/analyzer/codeFlowEngine.ts)
*   **Type Evaluation**: The core of type inference and evaluation logic.
    *   *Implementation*: [`packages/pyright-internal/src/analyzer/typeEvaluator.ts`](../packages/pyright-internal/src/analyzer/typeEvaluator.ts)
    *   *Tests*: [`packages/pyright-internal/src/tests/typeEvaluator1.test.ts`](../packages/pyright-internal/src/tests/typeEvaluator1.test.ts) (and other `typeEvaluator*.test.ts` files)

When inference is impossible, the checker uses the fallback type `typing.Any`, which acts as an "escape hatch" to disable checks for a particular symbol.

## 4. The Boundary Contract: Checking Code vs. Libraries

Pyright establishes a "Boundary Contract" to differentiate between project code and libraries. It uses a hierarchy of sources to find type information:

1.  **Inline Type Hints**: Hints written directly in source code.
2.  **Type Stubs**: "Sidecar" `.pyi` files that contain only type signatures. Pyright includes a fallback for the standard library in [`packages/pyright-internal/typeshed-fallback/`](../packages/pyright-internal/typeshed-fallback/).
3.  **Fallback to `Any`**: If no hints or stubs are found, the checker assumes `Any`.

## 5. Defining the Boundary: How a Checker Knows What to Check

The boundary between "your code" and "library code" is established by a clear set of rules:

*   **The Project Root**: The directory where you run the tool (e.g., `pyright .`) is considered "your code." The entry point for command-line execution is [`packages/pyright-internal/src/pyright.ts`](../packages/pyright-internal/src/pyright.ts).
*   **The Import Resolution Path**: When the checker sees an `import` statement, it resolves the module's location. If the path is outside the project root (e.g., in `site-packages`), the boundary is crossed.
    *   *Implementation*: [`packages/pyright-internal/src/analyzer/importResolver.ts`](../packages/pyright-internal/src/analyzer/importResolver.ts)
    *   *Tests*: [`packages/pyright-internal/src/tests/importResolver.test.ts`](../packages/pyright-internal/src/tests/importResolver.test.ts)
*   **Configuration**: Users can fine-tune this boundary using configuration files.

## 6. Environment Management

Pyright is designed to work with different Python environments (e.g., global installations, virtual environments like `venv`). This is crucial for correct import resolution and type checking against the right versions of installed libraries.

*   **Environment Discovery**: Pyright discovers the environment by resolving a Python interpreter. This is typically configured via the `pythonPath` setting.
*   **Path Resolution**: Once the interpreter is located, Pyright executes it to determine the correct search paths for that environment (i.e., the `site-packages` directory). This ensures that Pyright finds the same installed packages that the Python interpreter would at runtime.
    *   *Implementation*: The logic for finding interpreters and resolving search paths is centralized in [`packages/pyright-internal/src/analyzer/pythonPathUtils.ts`](../packages/pyright-internal/src/analyzer/pythonPathUtils.ts).
    *   *Tests*: Configuration-related tests, including those for path resolution, can be found in [`packages/pyright-internal/src/tests/config.test.ts`](../packages/pyright-internal/src/tests/config.test.ts).