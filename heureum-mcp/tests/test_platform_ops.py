# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for Platform API-backed filesystem Operations."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from src.tools.filesystem.platform_ops import (
    PlatformEditOperations,
    PlatformFileClient,
    PlatformFindOperations,
    PlatformLsOperations,
    PlatformReadOperations,
    PlatformWriteOperations,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    """Create a PlatformFileClient with test config."""
    return PlatformFileClient(
        platform_api_url="http://localhost:8001",
        session_id="test-session-123",
        cwd="/session",
    )


# ---------------------------------------------------------------------------
# PlatformFileClient
# ---------------------------------------------------------------------------


class TestPlatformFileClient:
    """Tests for PlatformFileClient path conversion and HTTP calls."""

    def test_to_session_path_strips_cwd(self, client):
        assert client.to_session_path("/session/notes/todo.md") == "notes/todo.md"

    def test_to_session_path_root(self, client):
        assert client.to_session_path("/session") == ""

    def test_to_session_path_already_relative(self, client):
        assert client.to_session_path("notes/todo.md") == "notes/todo.md"

    def test_to_session_path_nested(self, client):
        assert client.to_session_path("/session/a/b/c.txt") == "a/b/c.txt"

    def test_base_url_formation(self, client):
        assert "test-session-123" in client._base_url
        assert client._base_url.endswith("/files")

    @pytest.mark.asyncio
    async def test_read_file_success(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"content": "hello world"}

        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        content = await client.read_file("notes/todo.md")
        assert content == "hello world"
        client._http.get.assert_called_once()

    @pytest.mark.asyncio
    async def test_read_file_not_found(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 404

        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        with pytest.raises(FileNotFoundError):
            await client.read_file("nonexistent.md")

    @pytest.mark.asyncio
    async def test_write_file_success(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 201

        client._http = AsyncMock()
        client._http.post = AsyncMock(return_value=mock_resp)

        await client.write_file("notes/new.md", "content")
        client._http.post.assert_called_once()
        call_kwargs = client._http.post.call_args
        body = call_kwargs.kwargs["json"]
        assert body["path"] == "notes/new.md"
        assert body["content"] == "content"
        assert body["created_by"] == "agent"

    @pytest.mark.asyncio
    async def test_write_file_error(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "Internal Server Error"
        mock_resp.json.return_value = {"error": "disk full"}

        client._http = AsyncMock()
        client._http.post = AsyncMock(return_value=mock_resp)

        with pytest.raises(RuntimeError, match="disk full"):
            await client.write_file("notes/fail.md", "content")

    @pytest.mark.asyncio
    async def test_list_files(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {"path": "notes/todo.md", "size": 100, "content_type": "text/markdown"},
            {"path": "data.csv", "size": 500, "content_type": "text/csv"},
        ]

        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        files = await client.list_files()
        assert len(files) == 2
        assert files[0]["path"] == "notes/todo.md"

    @pytest.mark.asyncio
    async def test_file_exists_true(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"content": "exists"}

        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        assert await client.file_exists("notes/todo.md") is True

    @pytest.mark.asyncio
    async def test_file_exists_false(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 404

        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        assert await client.file_exists("nonexistent.md") is False


# ---------------------------------------------------------------------------
# PlatformReadOperations
# ---------------------------------------------------------------------------


class TestPlatformReadOperations:
    @pytest.mark.asyncio
    async def test_read_file_returns_bytes(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"content": "file content"}
        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        ops = PlatformReadOperations(client)
        result = await ops.read_file("/session/test.txt")

        assert isinstance(result, bytes)
        assert result == b"file content"

    @pytest.mark.asyncio
    async def test_access_success(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"content": "exists"}
        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        ops = PlatformReadOperations(client)
        await ops.access("/session/test.txt")  # Should not raise

    @pytest.mark.asyncio
    async def test_access_file_not_found(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 404
        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        ops = PlatformReadOperations(client)
        with pytest.raises(FileNotFoundError):
            await ops.access("/session/nonexistent.txt")

    def test_detect_image_mime_type(self, client):
        import asyncio

        ops = PlatformReadOperations(client)

        result = asyncio.get_event_loop().run_until_complete(
            ops.detect_image_mime_type("/session/photo.png")
        )
        assert result == "image/png"

        result = asyncio.get_event_loop().run_until_complete(
            ops.detect_image_mime_type("/session/doc.txt")
        )
        assert result is None


# ---------------------------------------------------------------------------
# PlatformWriteOperations
# ---------------------------------------------------------------------------


class TestPlatformWriteOperations:
    @pytest.mark.asyncio
    async def test_write_file(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 201
        client._http = AsyncMock()
        client._http.post = AsyncMock(return_value=mock_resp)

        ops = PlatformWriteOperations(client)
        await ops.write_file("/session/notes/new.md", "hello")

        call_kwargs = client._http.post.call_args
        body = call_kwargs.kwargs["json"]
        assert body["path"] == "notes/new.md"

    @pytest.mark.asyncio
    async def test_mkdir_is_noop(self, client):
        ops = PlatformWriteOperations(client)
        await ops.mkdir("/session/notes")  # Should not raise


# ---------------------------------------------------------------------------
# PlatformEditOperations
# ---------------------------------------------------------------------------


class TestPlatformEditOperations:
    @pytest.mark.asyncio
    async def test_read_then_write(self, client):
        """Edit operations can read and write through Platform API."""
        read_resp = MagicMock()
        read_resp.status_code = 200
        read_resp.json.return_value = {"content": "old content"}

        write_resp = MagicMock()
        write_resp.status_code = 200

        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=read_resp)
        client._http.post = AsyncMock(return_value=write_resp)

        ops = PlatformEditOperations(client)

        data = await ops.read_file("/session/file.txt")
        assert data == b"old content"

        await ops.write_file("/session/file.txt", "new content")
        body = client._http.post.call_args.kwargs["json"]
        assert body["path"] == "file.txt"
        assert body["content"] == "new content"


# ---------------------------------------------------------------------------
# PlatformLsOperations
# ---------------------------------------------------------------------------


class TestPlatformLsOperations:
    def test_readdir_parses_flat_files(self, client):
        """readdir extracts file names from Platform API list response."""

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {"path": "todo.md", "size": 100, "content_type": "text/markdown"},
            {"path": "data.csv", "size": 500, "content_type": "text/csv"},
        ]

        with patch("src.tools.filesystem.platform_ops.httpx.Client") as MockClient:
            mock_client_instance = MagicMock()
            mock_client_instance.__enter__ = MagicMock(return_value=mock_client_instance)
            mock_client_instance.__exit__ = MagicMock(return_value=False)
            mock_client_instance.get.return_value = mock_resp
            MockClient.return_value = mock_client_instance

            ops = PlatformLsOperations(client)
            entries = ops.readdir("/session")

        assert "todo.md" in entries
        assert "data.csv" in entries

    def test_readdir_groups_directories(self, client):
        """readdir groups nested paths into directory entries."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {"path": "notes/todo.md", "size": 100, "content_type": "text/markdown"},
            {"path": "notes/ideas.md", "size": 200, "content_type": "text/markdown"},
            {"path": "data.csv", "size": 500, "content_type": "text/csv"},
        ]

        with patch("src.tools.filesystem.platform_ops.httpx.Client") as MockClient:
            mock_client_instance = MagicMock()
            mock_client_instance.__enter__ = MagicMock(return_value=mock_client_instance)
            mock_client_instance.__exit__ = MagicMock(return_value=False)
            mock_client_instance.get.return_value = mock_resp
            MockClient.return_value = mock_client_instance

            ops = PlatformLsOperations(client)
            entries = ops.readdir("/session")

        assert "notes" in entries
        assert "data.csv" in entries
        # "notes" should appear only once (deduped)
        assert entries.count("notes") == 1

    def test_stat_file_is_not_directory(self, client):
        """stat() should classify exact file paths as files."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {"path": "report.txt", "size": 10, "content_type": "text/plain"},
        ]

        with patch("src.tools.filesystem.platform_ops.httpx.Client") as MockClient:
            mock_client_instance = MagicMock()
            mock_client_instance.__enter__ = MagicMock(return_value=mock_client_instance)
            mock_client_instance.__exit__ = MagicMock(return_value=False)
            mock_client_instance.get.return_value = mock_resp
            MockClient.return_value = mock_client_instance

            ops = PlatformLsOperations(client)
            stat = ops.stat("/session/report.txt")

        assert stat.is_directory() is False


# ---------------------------------------------------------------------------
# PlatformFindOperations
# ---------------------------------------------------------------------------


class TestPlatformFindOperations:
    @pytest.mark.asyncio
    async def test_glob_matches_pattern(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {"path": "notes/todo.md", "size": 100, "content_type": "text/markdown"},
            {"path": "notes/ideas.md", "size": 200, "content_type": "text/markdown"},
            {"path": "data.csv", "size": 500, "content_type": "text/csv"},
        ]
        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        ops = PlatformFindOperations(client)
        results = await ops.glob("*.md", "/session", [], 100)

        assert len(results) == 2
        assert all(r.endswith(".md") for r in results)

    @pytest.mark.asyncio
    async def test_glob_respects_limit(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {"path": f"file{i}.md", "size": 10, "content_type": "text/markdown"} for i in range(20)
        ]
        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        ops = PlatformFindOperations(client)
        results = await ops.glob("*.md", "/session", [], 5)

        assert len(results) == 5

    @pytest.mark.asyncio
    async def test_glob_applies_ignore(self, client):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {"path": "src/main.py", "size": 100, "content_type": "text/x-python"},
            {
                "path": "node_modules/pkg/index.js",
                "size": 200,
                "content_type": "text/javascript",
            },
        ]
        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        ops = PlatformFindOperations(client)
        results = await ops.glob("*", "/session", ["**/node_modules/**"], 100)

        assert len(results) == 1
        assert results[0] == "/session/src/main.py"

    @pytest.mark.asyncio
    async def test_glob_respects_cwd_prefix_without_duplication(self, client):
        """When cwd is nested, returned absolute paths should not duplicate prefixes."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = [
            {"path": "docs/a.md", "size": 100, "content_type": "text/markdown"},
            {"path": "docs/b.md", "size": 120, "content_type": "text/markdown"},
        ]
        client._http = AsyncMock()
        client._http.get = AsyncMock(return_value=mock_resp)

        ops = PlatformFindOperations(client)
        results = await ops.glob("*.md", "/session/docs", [], 100)

        assert results == ["/session/docs/a.md", "/session/docs/b.md"]
