# e2e_test_kvs_lib

An in-memory key-value store implemented in Python, using `click` for its command-line interface.

## Setup

This project uses a virtual environment to manage its dependencies.

1.  **Create the virtual environment:**

    ```bash
    python3 -m venv venv
    ```

2.  **Activate the virtual environment:**

    *   On macOS and Linux:
        ```bash
        source venv/bin/activate
        ```

3.  **Install the dependencies:**

    ```bash
    pip install -r requirements.txt
    ```

## Running the Server

Once the dependencies are installed, you can start the server using the `kvs-server` command:

```bash
kvs-server start-server --port 6380
```

The server will start listening on `127.0.0.1:6380`.

## Running Tests

To run the unit tests, make sure your virtual environment is activated and then run:

```bash
python3 -m unittest discover tests
```