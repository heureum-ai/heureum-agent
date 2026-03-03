# Copyright (c) 2026 Heureum AI. All rights reserved.

import logging
import re
import time

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage

logger = logging.getLogger(__name__)

_SAVE_MAX_RETRIES = 3
_SAVE_RETRY_DELAY = 0.05  # 50ms


class SessionFileStorage:
    """Manages files under sessions/{session_id}/ using Django's default storage backend."""

    MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB
    TEXT_DB_THRESHOLD = 1 * 1024 * 1024  # 1 MB

    TEXT_EXTENSIONS = {
        ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml",
        ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css",
        ".sh", ".bash", ".sql", ".log", ".ini", ".toml", ".cfg",
        ".env", ".gitignore", ".dockerfile", ".rst", ".tex",
    }

    TEXT_CONTENT_TYPES = {
        "text/plain", "text/markdown", "text/csv", "text/html",
        "text/css", "application/json", "application/xml",
        "application/x-yaml", "text/javascript",
    }

    @staticmethod
    def validate_path(path: str) -> str:
        """Validate and normalize a file path. Raises ValueError if invalid."""
        path = path.strip().lstrip("/")
        if not path:
            raise ValueError("Path cannot be empty")
        if "\x00" in path:
            raise ValueError("Path contains null bytes")
        if ".." in path.split("/"):
            raise ValueError("Path traversal not allowed")
        if re.search(r'[<>:"|?*\\]', path):
            raise ValueError("Path contains invalid characters")
        return path

    @classmethod
    def _blob_name(cls, session_id: str, path: str) -> str:
        return f"sessions/{session_id}/{path}"

    @classmethod
    def save(cls, session_id: str, path: str, content: bytes) -> str:
        """Save file content to storage. Returns the storage name.

        Retries on FileNotFoundError to handle race conditions when
        concurrent requests delete/recreate the same file path (the
        Django FileSystemStorage ``os.chmod`` call can fail if another
        request deletes the file between the write and chmod).
        """
        name = cls._blob_name(session_id, path)
        last_err: Exception | None = None
        for attempt in range(_SAVE_MAX_RETRIES):
            try:
                if default_storage.exists(name):
                    default_storage.delete(name)
                saved_name = default_storage.save(name, ContentFile(content))
                return saved_name
            except FileNotFoundError as exc:
                last_err = exc
                logger.debug(
                    "Session file save race (attempt %d/%d): %s",
                    attempt + 1,
                    _SAVE_MAX_RETRIES,
                    name,
                )
                time.sleep(_SAVE_RETRY_DELAY)
        raise last_err  # type: ignore[misc]

    @classmethod
    def read(cls, session_id: str, path: str) -> bytes:
        """Read file content from storage."""
        name = cls._blob_name(session_id, path)
        with default_storage.open(name, "rb") as f:
            return f.read()

    @classmethod
    def delete(cls, session_id: str, path: str) -> None:
        """Delete a file from storage."""
        name = cls._blob_name(session_id, path)
        if default_storage.exists(name):
            default_storage.delete(name)

    @classmethod
    def delete_session(cls, session_id: str) -> None:
        """Delete all files for a session."""
        prefix = f"sessions/{session_id}"
        try:
            dirs, files = default_storage.listdir(prefix)
        except FileNotFoundError:
            return
        # Delete files at this level
        for filename in files:
            default_storage.delete(f"{prefix}/{filename}")
        # Recurse into subdirectories
        for dirname in dirs:
            cls._delete_dir(f"{prefix}/{dirname}")

    @classmethod
    def _delete_dir(cls, path: str) -> None:
        """Recursively delete all files under a storage path."""
        try:
            dirs, files = default_storage.listdir(path)
        except FileNotFoundError:
            return
        for filename in files:
            default_storage.delete(f"{path}/{filename}")
        for dirname in dirs:
            cls._delete_dir(f"{path}/{dirname}")

    @classmethod
    def is_text_file(cls, filename: str, content_type: str) -> bool:
        """Check if a file is a text file based on extension or content type."""
        ext = ""
        if "." in filename:
            ext = "." + filename.rsplit(".", 1)[-1].lower()
        return ext in cls.TEXT_EXTENSIONS or content_type in cls.TEXT_CONTENT_TYPES
