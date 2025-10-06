from .server import Server

def main():
    """
    Initializes and starts the key-value store server,
    pre-populating it with some data.
    """
    server = Server()

    # Pre-populate with some data
    server.storage.set("name", "Gemini")
    server.storage.set("version", "1.0")

    print("Starting server with pre-populated data...")
    server.run()

if __name__ == '__main__':
    main()