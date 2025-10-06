import socket
import sys

def main():
    if len(sys.argv) < 2:
        print("Usage: python client.py <command> [key] [value]")
        sys.exit(1)

    host = '127.0.0.1'
    port = 6379
    command = ' '.join(sys.argv[1:])

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.connect((host, port))
        s.sendall(command.encode('utf-8'))
        response = s.recv(1024)
        print(response.decode('utf-8'), end='')

if __name__ == '__main__':
    main()