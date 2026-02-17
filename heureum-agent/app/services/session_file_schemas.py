# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Session file tool schemas for LLM binding."""

READ_FILE_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": (
            "Read a file from the session's cloud file storage. "
            "Use this to read files uploaded by the user or previously saved by you."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path within the session (e.g. 'notes/todo.md', 'data.csv')",
                }
            },
            "required": ["path"],
        },
    },
}

WRITE_FILE_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "write_file",
        "description": (
            "Write or create a file in the session's cloud file storage. "
            "Creates the file if it doesn't exist, or overwrites if it does. "
            "Good for saving to-do lists, notes, code snippets, or any content "
            "the user may want to reference later."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "File path within the session (e.g. 'notes/todo.md')"},
                "content": {"type": "string", "description": "Text content to write"},
            },
            "required": ["path", "content"],
        },
    },
}

LIST_FILES_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "list_files",
        "description": "List all files in the session's cloud file storage, optionally filtered by directory path.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Optional directory prefix to filter (e.g. 'notes/'). Omit to list all files.",
                }
            },
        },
    },
}

DELETE_FILE_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "delete_file",
        "description": "Delete a file from the session's cloud file storage.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "File path to delete (e.g. 'notes/old-todo.md')",
                }
            },
            "required": ["path"],
        },
    },
}

SESSION_FILE_TOOL_SCHEMAS = [
    READ_FILE_TOOL_SCHEMA,
    WRITE_FILE_TOOL_SCHEMA,
    LIST_FILES_TOOL_SCHEMA,
    DELETE_FILE_TOOL_SCHEMA,
]
