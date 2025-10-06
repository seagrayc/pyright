import unittest
from src.storage import Storage
from src.protocol import parse_command, format_response
from src.server import Server

class TestKVSLib(unittest.TestCase):

    def test_storage(self):
        storage = Storage()
        self.assertIsNone(storage.get("name"))
        storage.set("name", "Gemini-lib")
        self.assertEqual(storage.get("name"), "Gemini-lib")
        storage.delete("name")
        self.assertIsNone(storage.get("name"))

    def test_protocol(self):
        command, key, value = parse_command("SET name Gemini-lib")
        self.assertEqual(command, "SET")
        self.assertEqual(key, "name")
        self.assertEqual(value, "Gemini-lib")

        response = format_response("OK")
        self.assertEqual(response, "OK\n")

    def test_server_commands(self):
        server = Server()
        self.assertEqual(server.execute_command("SET", "name", "Gemini-lib"), "OK")
        self.assertEqual(server.execute_command("GET", "name", None), "Gemini-lib")
        self.assertEqual(server.execute_command("DELETE", "name", None), "1")
        self.assertEqual(server.execute_command("GET", "name", None), None)

if __name__ == '__main__':
    unittest.main()