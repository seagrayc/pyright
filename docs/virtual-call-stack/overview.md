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

`packages/pyright-internal/src/tests/getCallStack.e2e.test.ts` provides sufficient functionality for early testing - using this as the golden reference; if any requirements are contradicted in the docs; take the test source code as the final spec.

The goal is to leverage the core functionality in the test case, and wrap in under a Model Content Protocol Server

### Step 1: Tooling Setup & Initial Analysis
1.  **Project Setup**: Create a new folder under `packages/pyright-internal` called `virtual-callstack-mcp`
2.  Review `/home/brent/repos/personal/pyright/model-context-protocol-server-example/weather-server-typescript-mcp-server-example` and use it as a template to create a basic MCP Server (obviously ignore all the functionality related to weather service)
### Step 2: Building the Core API
Expose the below MCP tools in the new MCP sever

1.  **Implement `get_call_stack`**:
    *   Call `initialize_project` if needed
    *   Create a function that takes a file path and line number.
    *   Wrap this logic in a recursive function that continues traversal to the specified `depth`, collecting function identifiers along the way.
