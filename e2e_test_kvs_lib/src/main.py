import click
from .server import Server

@click.group()
def cli():
    pass

@cli.command()
@click.option('--host', default='127.0.0.1', help='The host to bind to.')
@click.option('--port', default=6380, help='The port to listen on.')
def start_server(host, port):
    """Starts the key-value store server."""
    server = Server(host=host, port=port)

    # Pre-populate with some data
    server.storage.set("name", "Gemini-lib")
    server.storage.set("version", "1.0-lib")

    print("Starting server with pre-populated data...")
    server.run()

if __name__ == '__main__':
    cli()