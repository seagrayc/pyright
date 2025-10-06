import socket
from .storage import Storage
from .protocol import parse_command, format_response

class Server:
    def __init__(self, host='127.0.0.1', port=6379):
        self.storage = Storage()
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.bind((host, port))
        self._socket.listen(1)
        print(f"Listening on {host}:{port}")

    def run(self):
        while True:
            conn, addr = self._socket.accept()
            print(f"Connection from {addr}")
            self.handle_connection(conn)

    def handle_connection(self, conn):
        with conn:
            while True:
                data = conn.recv(1024)
                if not data:
                    break
                command_str = data.decode('utf-8')
                command, key, value = parse_command(command_str)
                response = self.execute_command(command, key, value)
                conn.sendall(format_response(response).encode('utf-8'))

    def execute_command(self, command, key, value):
        if command == 'GET':
            return self.storage.get(key)
        elif command == 'SET':
            self.storage.set(key, value)
            return "OK"
        elif command == 'DELETE':
            if self.storage.delete(key):
                return "1"
            return "0"
        else:
            return "ERROR: Unknown command"

def main():
    server = Server()
    server.run()

if __name__ == '__main__':
    main()