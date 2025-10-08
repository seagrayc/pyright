# Pyright: Dependency and Environment Management

For Pyright to perform its static analysis, it must understand the project's dependency structure. This includes resolving `import` statements for standard library modules, third-party packages, and local project modules. To do this, Pyright needs to know which Python environment is being used for the project. This document explains how Pyright interacts with Python environments and what information must be "handed off" to it to enable this analysis.

## The "Hand-off": What Pyright Needs

At its core, Pyright needs to replicate the import resolution behavior of a specific Python interpreter. To do this, it needs to be "handed" the location of that Python environment. This is primarily achieved through configuration files that tell Pyright which interpreter to use or where to find the project's virtual environment.

Once Pyright identifies the environment, it can determine the correct `sys.path`, which includes:
- The standard library location.
- The `site-packages` directory where third-party libraries are installed.
- Any additional paths specified in the configuration.

This allows Pyright to locate and parse the source code or type stubs for all imported modules.

## Configuration: `pyrightconfig.json` and `pyproject.toml`

The primary mechanism for configuring Pyright's environment is a `pyrightconfig.json` file or a `[tool.pyright]` section within a `pyproject.toml` file at the project's root.

The settings in these files are loaded by the `AnalyzerService` when it initializes.

**File Link**:
- [`packages/pyright-internal/src/analyzer/service.ts`](packages/pyright-internal/src/analyzer/service.ts): The `_getConfigOptions` method orchestrates the discovery and loading of configuration files.

The key configuration options for dependency management are defined in `ConfigOptions` and include:

- `pythonPath`: A direct path to a Python executable. If set, Pyright will query this interpreter to get its search paths.
- `venvPath`: The path to a directory that contains virtual environments (e.g., `.venv`).
- `venv`: The name of the specific virtual environment directory within `venvPath` to use for the project.
- `executionEnvironments`: For complex projects, this allows you to define multiple environments, each with its own root directory, Python version, and extra paths.

**File Link**:
- [`packages/pyright-internal/src/common/configOptions.ts`](packages/pyright-internal/src/common/configOptions.ts): This file defines the `ConfigOptions` class and all possible settings.

## Environment Discovery and Search Path Resolution

Once the configuration is loaded, Pyright resolves the Python search paths. This logic is primarily handled by the `findPythonSearchPaths` function.

**File Link**:
- [`packages/pyright-internal/src/analyzer/pythonPathUtils.ts`](packages/pyright-internal/src/analyzer/pythonPathUtils.ts): This utility file contains the logic for discovering search paths based on the provided configuration.

The resolution process follows a clear order of precedence:

1.  **Virtual Environment First**: If `venvPath` and `venv` are specified in the configuration, Pyright gives them top priority. It constructs the path to the virtual environment and looks for the `site-packages` directory within it.

    ```typescript
    // From: packages/pyright-internal/src/analyzer/pythonPathUtils.ts
    export function findPythonSearchPaths(
        fs: FileSystem,
        configOptions: ConfigOptions,
        host: Host,
        // ...
    ): Uri[] {
        // ...
        if (configOptions.venvPath !== undefined && configOptions.venv) {
            const venvDir = configOptions.venv;
            const venvPath = configOptions.venvPath.combinePaths(venvDir);

            // ... logic to find site-packages in venvPath ...
        }
        // ...
    }
    ```

2.  **Interpreter Fallback**: If a virtual environment is not configured, Pyright falls back to using a Python interpreter to determine the search paths. It uses the interpreter specified by `pythonPath` in the configuration, or a default interpreter discovered on the system if `pythonPath` is not set.

    ```typescript
    // From: packages/pyright-internal/src/analyzer/pythonPathUtils.ts

        // ...
        // Fall back on the python interpreter.
        const pathResult = host.getPythonSearchPaths(configOptions.pythonPath, importLogger);
        // ...
    }
    ```
    The `host.getPythonSearchPaths` method is an abstraction that executes the Python interpreter and retrieves its `sys.path`.

## Testing and Verification

This entire configuration and discovery mechanism is thoroughly tested. The tests confirm that settings are read correctly from both `pyrightconfig.json` and `pyproject.toml`, that virtual environments are handled as expected, and that setting precedence is respected.

**Test File Link**:
- [`packages/pyright-internal/src/tests/config.test.ts`](packages/pyright-internal/src/tests/config.test.ts)

Key examples from the test suite include:

- **`BasicPyprojectTomlParsing`**: Verifies that settings like `pythonVersion` and diagnostic rules are correctly parsed from a `pyproject.toml` file.
  - **Sample Config**: `src/tests/samples/project_with_pyproject_toml/pyproject.toml`
- **`FindFilesVirtualEnvAutoDetectExclude`**: Tests the behavior where a directory named `venv` is automatically excluded from analysis if no other `exclude` paths are specified by the user.
  - **Sample Config**: `src/tests/samples/project_with_venv_auto_detect_exclude/pyrightconfig.json`
- **`Extended config files`**: Confirms that settings are correctly inherited when a config file uses the `extends` property to build upon a base configuration.
  - **Sample Config**: `src/tests/samples/project_with_extended_config/pyrightconfig.json`

By examining these tests, one can gain a comprehensive understanding of how different configuration scenarios are intended to work.