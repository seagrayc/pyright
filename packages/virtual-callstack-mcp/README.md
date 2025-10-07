# Virtual Call Stack MCP Server

This package provides a Model Content Protocol (MCP) server that exposes the internal call analysis capabilities of the Pyright type checker.

## Features

*   **`initialize_project`**: Analyzes a Python project to build a complete understanding of its structure and types.
*   **`get_call_stack`**: For a given position in a file, it returns a virtual call stack, showing both incoming and outgoing calls.

## Usage

This server is designed to be used by an AI agent that needs deep, structural context about a Python codebase to perform complex tasks. The agent would first call `initialize_project` with the root of the repository and then use `get_call_stack` to explore the code's logic.