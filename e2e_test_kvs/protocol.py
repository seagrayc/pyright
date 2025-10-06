def parse_command(command_str):
    parts = command_str.strip().split()
    if not parts:
        return None, None, None
    command = parts[0].upper()
    key = parts[1] if len(parts) > 1 else None
    value = ' '.join(parts[2:]) if len(parts) > 2 else None
    return command, key, value

def format_response(response):
    if response is None:
        return "(nil)\n"
    return f"{response}\n"