# Strategy for Providing Code Context to AI Agents

## 1. Core Problem
AI coding agents often lack sufficient context to perform complex tasks across large codebases. Current methods, such as providing raw files or relying solely on semantic embeddings, have significant limitations. While embeddings can capture general intent, they may lack the structural precision required for code. Conversely, purely syntactic tools lack the semantic bridge to interpret natural language queries effectively.

## 2. The Synthesized Approach: Combining Structure and Semantics
The most effective strategy is a hybrid model that integrates the strengths of precise static analysis with the conceptual understanding of language models. This creates a system that is both accurate and semantically aware.

*   **Structural Foundation (The "Map"):** The foundation is a detailed and accurate model of the entire codebase. This is achieved by parsing all source code into a complete syntax tree that captures every element, from function definitions to individual expressions. This creates a verifiable "ground truth" of the code's structure and relationships.
    *   *Building Block*: Pyright's parser, located in [`packages/pyright-internal/src/parser/`](../packages/pyright-internal/src/parser/), is responsible for creating these syntax trees. The [`binder`](../packages/pyright-internal/src/analyzer/binder.ts) then walks these trees to create symbols, forming the initial structural map.

*   **Semantic Layer (The "Labels"):** On top of this structural map, a semantic layer is applied. This layer understands the intent behind the code. It serves as the crucial bridge connecting abstract natural language queries (e.g., "Where is user authentication handled?") to the relevant structural nodes (e.g., the `login` function or `AuthService` class).
    *   *Building Block*: The [`TypeEvaluator`](../packages/pyright-internal/src/analyzer/typeEvaluator.ts) is the core of Pyright's semantic analysis. It resolves symbols, infers types, and understands the relationships between different parts of the code, providing the necessary semantic layer.

## 3. Concrete Implementation Plan: The Virtual Call Stack
The primary technical goal is to build a tool capable of generating "virtual call stacks" on demand. This system will programmatically resolve references and trace dependencies throughout the entire codebase, mirroring how a human developer investigates logic flows.

This capability unlocks three distinct and powerful layers of context that can be provided to an AI agent:

*   **High-Level Context (The Call Graph):** By tracing the callers and callees of a given function, the tool will generate a virtual call stack. This provides a dense overview of a function's role.
    *   *Building Block*: The [`CallHierarchyProvider`](../packages/pyright-internal/src/languageService/callHierarchyProvider.ts) contains the logic for finding both incoming and outgoing calls for a given symbol, making it the ideal foundation for this feature.

*   **Mid-Level Context (Documentation Extraction):** For each function in the virtual call stack, the system will extract its associated documentation (e.g., docstrings).
    *   *Building Block*: The [`DocStringConversion`](../packages/pyright-internal/src/analyzer/docStringConversion.ts) module can be used to parse and format docstrings once they are located. The location itself can be derived from the range information on a declaration node.

*   **Low-Level Context (Code on Demand):** When the agent requires a deep dive, the system will provide the full body definition of any function in the call stack.
    *   *Building Block*: Every declaration found by the `TypeEvaluator` has a `range` property, which provides the exact start and end offsets in the source file. This can be used to read the file and extract the source code for a specific function.

## 4. Technical Implementation Requirements

### Exposed Functions
The tool should expose a clear and simple API for the agent to interact with.

*   `initialize_project(project_root)`: Performs a one-time analysis of the entire codebase.
*   `get_call_stack(file_path, line_number, [depth], [justMyCode])`: Returns the virtual call stack for a given code location.
*   `get_documentation(function_identifier, [depth], [justMyCode])`: Retrieves documentation for a function and its callees.
*   `get_source_code(function_identifier | function_identifier[], [depth], [justMyCode])`: Retrieves the full source code for one or more functions.
*   `generate_documentation(function_identifier, [depth], [justMyCode])`: Uses an LLM to generate documentation.

### Implementation Steps

*   **For `initialize_project`**:
    *   **File Discovery**: Leverage Pyright's `Program` and `Service` classes, which manage file system scanning and analysis orchestration.
    *   **Parsing**: Use the existing [`parser`](../packages/pyright-internal/src/parser/).
    *   **Symbol Table Creation**: Adapt the logic from the [`binder`](../packages/pyright-internal/src/analyzer/binder.ts).
    *   **Reference Resolution**: Utilize the [`TypeEvaluator`](../packages/pyright-internal/src/analyzer/typeEvaluator.ts) to build the complete reference graph.

*   **For `get_call_stack`**:
    *   **Target Identification**: Use [`ReferencesProvider.getDeclarationForPosition`](../packages/pyright-internal/src/languageService/referencesProvider.ts) to find the symbol at a specific file location.
    *   **Graph Traversal**: Adapt the tree walkers and logic within the [`CallHierarchyProvider`](../packages/pyright-internal/src/languageService/callHierarchyProvider.ts) to recursively find callers and callees.
    *   **Stack Assembly**: Collect the identifiers and format them into a structured response.

*   **For `get_documentation` and `get_source_code`**:
    *   **Target Identification**: Use the symbol table created during initialization to look up function identifiers.
    *   **Recursive Traversal**: Use the reference graph to find callees.
    *   **Content Extraction**: For each function, use its declaration `range` to read the specific text span from the source file. Use [`DocStringConversion`](../packages/pyright-internal/src/analyzer/docStringConversion.ts) for parsing docstrings.

*   **For `generate_documentation`**:
    *   **Source Code Retrieval**: Use the `get_source_code` implementation.
    *   **LLM Invocation**: Pass the retrieved code to a large language model.
    *   **Formatting and Return**: Structure the LLM output.

## 5. Step-by-Step Implementation Process

This section outlines a practical plan for building the context management tool by leveraging the Pyright codebase.

### Step 1: Tooling Setup & Initial Analysis
1.  **Project Setup**: Initialize a new Node.js project with TypeScript. Add `pyright` as a dependency to gain access to its internal modules.
2.  **Create an Analysis Service**: Create a wrapper class that instantiates Pyright's core `Service` or `Program` object. This object will manage the state of the analyzed Python project.
3.  **Implement `initialize_project`**: This function will trigger the analysis service to scan the target Python repository, parse all files, and run the binder and type evaluator. This process populates the internal data structures (ASTs, symbol tables, reference graph) that subsequent API calls will query. This effectively pre-computes the entire codebase map.

### Step 2: Building the Core API
1.  **Implement `get_call_stack`**:
    *   Create a function that takes a file path and line number.
    *   Use `ReferencesProvider.getDeclarationForPosition` to identify the function or method at that location.
    *   Instantiate `CallHierarchyProvider` with the identified declaration.
    *   Use its `getIncomingCalls` and `getOutgoingCalls` methods to perform the first level of traversal.
    *   Wrap this logic in a recursive function that continues traversal to the specified `depth`, collecting function identifiers along the way.
2.  **Implement `get_source_code` / `get_documentation`**:
    *   These functions will take a function identifier (e.g., `module.ClassName.method_name`).
    *   Use the symbol table from the initialized analysis service to find the `Declaration` object for that identifier.
    *   The `Declaration` object contains the source file URI and a `range` (start and end offsets).
    *   Read the source file and extract the text within the `range` to get the full source code. For documentation, extract the docstring from the function's parse node.

### Step 3: Testing Against Complex Repositories
1.  **Select Test Targets**: Choose several large, well-structured open-source Python projects (e.g., `django`, `requests`, `pandas`) as testbeds for the tool.
2.  **Develop an Integration Test Suite**:
    *   Create tests that run `initialize_project` on the target repositories.
    *   Write test cases for `get_call_stack` that query known hotspots in the testbed repositories and assert that the returned call graph is accurate.
    *   Write tests for `get_source_code` and `get_documentation` to ensure they correctly extract content for various functions.
    *   *Reference*: Pyright's own "four-slash" tests provide an excellent model for this kind of integration testing. See files like [`showcallhierarchy.outgoingCalls.function.fourslash.ts`](../packages/pyright-internal/src/tests/fourslash/showcallhierarchy.outgoingCalls.function.fourslash.ts) for examples of how to script and verify language service features.
3.  **Benchmark Performance**: Measure the time and memory required for `initialize_project` on large repositories to identify potential bottlenecks and areas for optimization.