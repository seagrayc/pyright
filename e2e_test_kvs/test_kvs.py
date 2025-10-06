import unittest
from .storage import Storage
from .protocol import parse_command, format_response
from .server import Server

class TestKVS(unittest.TestCase):

    def test_storage(self):
        storage = Storage()
        self.assertIsNone(storage.get("name"))
        storage.set("name", "Gemini")
        self.assertEqual(storage.get("name"), "Gemini")
        storage.delete("name")
        self.assertIsNone(storage.get("name"))

    def test_protocol(self):
        command, key, value = parse_command("SET name Gemini")
        self.assertEqual(command, "SET")
        self.assertEqual(key, "name")
        self.assertEqual(value, "Gemini")

        response = format_response("OK")
        self.assertEqual(response, "OK\n")

    def test_server_commands(self):
        server = Server()
        self.assertEqual(server.execute_command("SET", "name", "Gemini"), "OK")
        self.assertEqual(server.execute_command("GET", "name", None), "Gemini")
        self.assertEqual(server.execute_command("DELETE", "name", None), "1")
        self.assertEqual(server.execute_command("GET", "name", None), None)

if __name__ == '__main__':
    unittest.main()