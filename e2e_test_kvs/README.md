# e2e_test_kvs

A simple in-memory key-value store implemented in Python with no external dependencies.

## Running the Server

To start the server, run the `main.py` script:

```bash
python3 -m e2e_test_kvs.main
```

The server will start listening on `127.0.0.1:6379`.

## Using the Client

You can use the provided client to interact with the server from the command line:

```bash
# Set a key
python3 -m e2e_test_kvs.client SET mykey "some value"

# Get a key
python3 -m e2e_test_kvs.client GET mykey

# Delete a key
python3 -m e2e_test_kvs.client DELETE mykey
```

## Running Tests

To run the unit tests, use the following command:

```bash
python3 -m unittest e2e_test_kvs/test_kvs.py
```