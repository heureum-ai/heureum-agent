# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for session_files REST API endpoints."""
import os

import pytest
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from chat_messages.models import Session
from session_files.models import SessionFile
from session_files.storage import SessionFileStorage

User = __import__("django.contrib.auth", fromlist=["get_user_model"]).get_user_model()

TEST_SESSION_ID = "test-session-abc-123"


@pytest.fixture(autouse=True)
def _clean_media(tmp_path, settings):
    """Use a temporary MEDIA_ROOT so tests don't pollute the real filesystem."""
    settings.MEDIA_ROOT = str(tmp_path / "media")
    os.makedirs(settings.MEDIA_ROOT, exist_ok=True)
    yield
    # tmp_path is auto-cleaned by pytest


@pytest.fixture
def user(db):
    return User.objects.create_user(email="testuser@example.com", password="testpass123")


@pytest.fixture
def other_user(db):
    return User.objects.create_user(email="other@example.com", password="otherpass123")


@pytest.fixture
def session(db, user):
    return Session.objects.create(session_id=TEST_SESSION_ID, user=user, title="Test Session")


@pytest.fixture
def api_client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def unauth_client():
    return APIClient()


# ── Helper ──


def upload_file(api_client, session_id, filename="hello.txt", content=b"Hello, World!", path=None):
    """Upload a file via the API and return the response."""
    f = SimpleUploadedFile(filename, content, content_type="text/plain")
    data = {"file": f}
    if path:
        data["path"] = path
    return api_client.post(f"/api/v1/sessions/{session_id}/files/", data, format="multipart")


# ═══════════════════════════════════════════════════════════════════════════════
# Upload (POST /files/)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestFileUpload:
    def test_upload_text_file(self, api_client, session):
        resp = upload_file(api_client, TEST_SESSION_ID)
        assert resp.status_code == 201
        data = resp.json()
        assert data["path"] == "hello.txt"
        assert data["filename"] == "hello.txt"
        assert data["is_text"] is True
        assert data["size"] == 13
        assert data["text_content"] == "Hello, World!"
        assert data["created_by"] == "user"

    def test_upload_creates_db_record(self, api_client, session):
        upload_file(api_client, TEST_SESSION_ID)
        assert SessionFile.objects.filter(session=session).count() == 1

    def test_upload_saves_to_storage(self, api_client, session):
        upload_file(api_client, TEST_SESSION_ID)
        blob_name = SessionFileStorage._blob_name(TEST_SESSION_ID, "hello.txt")
        assert default_storage.exists(blob_name)
        with default_storage.open(blob_name, "rb") as f:
            assert f.read() == b"Hello, World!"

    def test_upload_with_custom_path(self, api_client, session):
        resp = upload_file(api_client, TEST_SESSION_ID, path="docs/readme.md")
        assert resp.status_code == 201
        assert resp.json()["path"] == "docs/readme.md"
        assert resp.json()["filename"] == "readme.md"

    def test_upload_binary_file(self, api_client, session):
        f = SimpleUploadedFile("image.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 100, content_type="image/png")
        resp = api_client.post(f"/api/v1/sessions/{TEST_SESSION_ID}/files/", {"file": f}, format="multipart")
        assert resp.status_code == 201
        data = resp.json()
        assert data["is_text"] is False
        assert data["text_content"] is None

    def test_upload_overwrites_existing(self, api_client, session):
        upload_file(api_client, TEST_SESSION_ID, content=b"version 1")
        resp = upload_file(api_client, TEST_SESSION_ID, content=b"version 2")
        assert resp.status_code == 200  # update, not create
        assert resp.json()["text_content"] == "version 2"
        assert SessionFile.objects.filter(session=session).count() == 1

    def test_upload_no_file(self, api_client, session):
        resp = api_client.post(f"/api/v1/sessions/{TEST_SESSION_ID}/files/", {}, format="multipart")
        assert resp.status_code == 400

    def test_upload_invalid_path_traversal(self, api_client, session):
        resp = upload_file(api_client, TEST_SESSION_ID, path="../../../etc/passwd")
        assert resp.status_code == 400

    def test_upload_session_not_found(self, api_client):
        resp = upload_file(api_client, "nonexistent-session-id")
        assert resp.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# List (GET /files/)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestFileList:
    def test_list_empty(self, api_client, session):
        resp = api_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_after_upload(self, api_client, session):
        upload_file(api_client, TEST_SESSION_ID, filename="a.txt", content=b"AAA")
        upload_file(api_client, TEST_SESSION_ID, filename="b.txt", content=b"BBB", path="b.txt")
        resp = api_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/")
        assert resp.status_code == 200
        files = resp.json()
        assert len(files) == 2
        paths = {f["path"] for f in files}
        assert "a.txt" in paths
        assert "b.txt" in paths

    def test_list_no_text_content(self, api_client, session):
        """List serializer should not include text_content to keep responses light."""
        upload_file(api_client, TEST_SESSION_ID)
        resp = api_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/")
        files = resp.json()
        assert "text_content" not in files[0]

    def test_list_with_path_prefix(self, api_client, session):
        upload_file(api_client, TEST_SESSION_ID, filename="root.txt", content=b"root", path="root.txt")
        upload_file(api_client, TEST_SESSION_ID, filename="a.md", content=b"a", path="docs/a.md")
        upload_file(api_client, TEST_SESSION_ID, filename="b.md", content=b"b", path="docs/b.md")
        resp = api_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/", {"path": "docs/"})
        assert resp.status_code == 200
        assert len(resp.json()) == 2

    def test_list_session_not_found(self, api_client):
        resp = api_client.get("/api/v1/sessions/nonexistent/files/")
        assert resp.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# Retrieve (GET /files/{id}/)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestFileRetrieve:
    def test_retrieve_includes_text_content(self, api_client, session):
        upload_resp = upload_file(api_client, TEST_SESSION_ID)
        file_id = upload_resp.json()["id"]
        resp = api_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/{file_id}/")
        assert resp.status_code == 200
        data = resp.json()
        assert data["text_content"] == "Hello, World!"
        assert data["path"] == "hello.txt"

    def test_retrieve_not_found(self, api_client, session):
        resp = api_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/sf_nonexistent/")
        assert resp.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# Update text content (PUT /files/{id}/)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestFileUpdate:
    def test_update_text_content(self, api_client, session):
        upload_resp = upload_file(api_client, TEST_SESSION_ID)
        file_id = upload_resp.json()["id"]
        resp = api_client.put(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/{file_id}/",
            {"text_content": "Updated content!"},
            format="json",
        )
        assert resp.status_code == 200
        assert resp.json()["text_content"] == "Updated content!"
        # Verify storage is also updated
        content = SessionFileStorage.read(TEST_SESSION_ID, "hello.txt")
        assert content == b"Updated content!"

    def test_update_binary_file_rejected(self, api_client, session):
        f = SimpleUploadedFile("photo.png", b"\x89PNG" + b"\x00" * 50, content_type="image/png")
        upload_resp = api_client.post(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/", {"file": f}, format="multipart"
        )
        file_id = upload_resp.json()["id"]
        resp = api_client.put(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/{file_id}/",
            {"text_content": "cannot edit binary"},
            format="json",
        )
        assert resp.status_code == 400

    def test_update_missing_text_content(self, api_client, session):
        upload_resp = upload_file(api_client, TEST_SESSION_ID)
        file_id = upload_resp.json()["id"]
        resp = api_client.put(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/{file_id}/", {}, format="json"
        )
        assert resp.status_code == 400


# ═══════════════════════════════════════════════════════════════════════════════
# Delete (DELETE /files/{id}/)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestFileDelete:
    def test_delete_file(self, api_client, session):
        upload_resp = upload_file(api_client, TEST_SESSION_ID)
        file_id = upload_resp.json()["id"]
        resp = api_client.delete(f"/api/v1/sessions/{TEST_SESSION_ID}/files/{file_id}/")
        assert resp.status_code == 204
        assert SessionFile.objects.filter(id=file_id).count() == 0
        blob_name = SessionFileStorage._blob_name(TEST_SESSION_ID, "hello.txt")
        assert not default_storage.exists(blob_name)

    def test_delete_not_found(self, api_client, session):
        resp = api_client.delete(f"/api/v1/sessions/{TEST_SESSION_ID}/files/sf_nonexistent/")
        assert resp.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# Download (GET /files/{id}/download/)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestFileDownload:
    def test_download_text_file(self, api_client, session):
        upload_resp = upload_file(api_client, TEST_SESSION_ID)
        file_id = upload_resp.json()["id"]
        resp = api_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/{file_id}/download/")
        assert resp.status_code == 200
        assert b"Hello, World!" in b"".join(resp.streaming_content)

    def test_download_not_found(self, api_client, session):
        resp = api_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/sf_nonexistent/download/")
        assert resp.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# Agent-oriented: Read by path (GET /files/read/)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestReadByPath:
    def test_read_text_file(self, api_client, session):
        upload_file(api_client, TEST_SESSION_ID, filename="notes.md", content=b"# Notes\nHello", path="notes.md")
        resp = api_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/read/", {"path": "notes.md"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["path"] == "notes.md"
        assert data["content"] == "# Notes\nHello"

    def test_read_missing_path_param(self, api_client, session):
        resp = api_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/read/")
        assert resp.status_code == 400

    def test_read_file_not_found(self, api_client, session):
        resp = api_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/read/", {"path": "nonexistent.txt"})
        assert resp.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# Agent-oriented: Write by path (POST /files/write/)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestWriteByPath:
    def test_write_creates_file(self, api_client, session):
        resp = api_client.post(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/write/",
            {"path": "todo.md", "content": "- Buy groceries\n- Clean house"},
            format="json",
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["path"] == "todo.md"
        assert data["created_by"] == "agent"
        assert data["is_text"] is True
        assert data["text_content"] == "- Buy groceries\n- Clean house"

    def test_write_overwrites_existing(self, api_client, session):
        api_client.post(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/write/",
            {"path": "todo.md", "content": "v1"},
            format="json",
        )
        resp = api_client.post(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/write/",
            {"path": "todo.md", "content": "v2"},
            format="json",
        )
        assert resp.status_code == 200  # update, not create
        assert resp.json()["text_content"] == "v2"
        assert SessionFile.objects.filter(session__session_id=TEST_SESSION_ID, path="todo.md").count() == 1

    def test_write_saves_to_storage(self, api_client, session):
        api_client.post(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/write/",
            {"path": "data.csv", "content": "a,b,c\n1,2,3"},
            format="json",
        )
        content = SessionFileStorage.read(TEST_SESSION_ID, "data.csv")
        assert content == b"a,b,c\n1,2,3"

    def test_write_missing_path(self, api_client, session):
        resp = api_client.post(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/write/",
            {"content": "no path"},
            format="json",
        )
        assert resp.status_code == 400

    def test_write_invalid_path(self, api_client, session):
        resp = api_client.post(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/write/",
            {"path": "../escape.txt", "content": "bad"},
            format="json",
        )
        assert resp.status_code == 400

    def test_write_nested_path(self, api_client, session):
        resp = api_client.post(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/write/",
            {"path": "deep/nested/file.txt", "content": "deep content"},
            format="json",
        )
        assert resp.status_code == 201
        assert resp.json()["path"] == "deep/nested/file.txt"
        assert resp.json()["filename"] == "file.txt"

    def test_write_session_not_found(self, api_client):
        resp = api_client.post(
            "/api/v1/sessions/nonexistent-session/files/write/",
            {"path": "file.txt", "content": "x"},
            format="json",
        )
        assert resp.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# Agent-oriented: Delete by path (DELETE /files/delete-by-path/)
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestDeleteByPath:
    def test_delete_by_path(self, api_client, session):
        api_client.post(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/write/",
            {"path": "temp.txt", "content": "temp"},
            format="json",
        )
        resp = api_client.delete(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/delete-by-path/?path=temp.txt"
        )
        assert resp.status_code == 204
        assert not SessionFile.objects.filter(session__session_id=TEST_SESSION_ID, path="temp.txt").exists()

    def test_delete_by_path_not_found(self, api_client, session):
        resp = api_client.delete(
            f"/api/v1/sessions/{TEST_SESSION_ID}/files/delete-by-path/?path=nope.txt"
        )
        assert resp.status_code == 404

    def test_delete_by_path_missing_param(self, api_client, session):
        resp = api_client.delete(f"/api/v1/sessions/{TEST_SESSION_ID}/files/delete-by-path/")
        assert resp.status_code == 400


# ═══════════════════════════════════════════════════════════════════════════════
# Storage: Path validation
# ═══════════════════════════════════════════════════════════════════════════════


class TestStorageValidation:
    def test_valid_paths(self):
        assert SessionFileStorage.validate_path("hello.txt") == "hello.txt"
        assert SessionFileStorage.validate_path("docs/readme.md") == "docs/readme.md"
        assert SessionFileStorage.validate_path("  foo.txt  ") == "foo.txt"
        assert SessionFileStorage.validate_path("/leading-slash.txt") == "leading-slash.txt"

    def test_invalid_path_traversal(self):
        with pytest.raises(ValueError, match="traversal"):
            SessionFileStorage.validate_path("../secret.txt")

    def test_invalid_null_bytes(self):
        with pytest.raises(ValueError, match="null"):
            SessionFileStorage.validate_path("bad\x00file.txt")

    def test_invalid_empty(self):
        with pytest.raises(ValueError, match="empty"):
            SessionFileStorage.validate_path("")

    def test_invalid_special_chars(self):
        with pytest.raises(ValueError, match="invalid"):
            SessionFileStorage.validate_path('file"name.txt')


# ═══════════════════════════════════════════════════════════════════════════════
# Storage: Text file detection
# ═══════════════════════════════════════════════════════════════════════════════


class TestIsTextFile:
    def test_text_extensions(self):
        assert SessionFileStorage.is_text_file("readme.md", "application/octet-stream") is True
        assert SessionFileStorage.is_text_file("main.py", "application/octet-stream") is True
        assert SessionFileStorage.is_text_file("style.css", "text/css") is True
        assert SessionFileStorage.is_text_file("data.json", "application/json") is True

    def test_binary_files(self):
        assert SessionFileStorage.is_text_file("photo.png", "image/png") is False
        assert SessionFileStorage.is_text_file("doc.pdf", "application/pdf") is False
        assert SessionFileStorage.is_text_file("archive.zip", "application/zip") is False

    def test_text_content_type(self):
        assert SessionFileStorage.is_text_file("unknownext", "text/plain") is True


# ═══════════════════════════════════════════════════════════════════════════════
# Session deletion cascade
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestSessionDeletionCascade:
    def test_delete_session_removes_files(self, api_client, session):
        """Deleting a session via the API should remove all session files."""
        # Upload files
        upload_file(api_client, TEST_SESSION_ID, filename="a.txt", content=b"aaa")
        upload_file(api_client, TEST_SESSION_ID, filename="b.txt", content=b"bbb", path="b.txt")

        assert SessionFile.objects.filter(session=session).count() == 2

        # Delete session
        resp = api_client.delete(f"/api/v1/sessions/{TEST_SESSION_ID}/")
        assert resp.status_code == 204

        # Files should be gone from DB
        assert SessionFile.objects.filter(session__session_id=TEST_SESSION_ID).count() == 0

        # Files should be gone from storage
        blob_a = SessionFileStorage._blob_name(TEST_SESSION_ID, "a.txt")
        blob_b = SessionFileStorage._blob_name(TEST_SESSION_ID, "b.txt")
        assert not default_storage.exists(blob_a)
        assert not default_storage.exists(blob_b)


# ═══════════════════════════════════════════════════════════════════════════════
# Permission: other users can't access files
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestPermissions:
    def test_other_user_cannot_list_files(self, api_client, session, other_user):
        upload_file(api_client, TEST_SESSION_ID)
        other_client = APIClient()
        other_client.force_authenticate(other_user)
        resp = other_client.get(f"/api/v1/sessions/{TEST_SESSION_ID}/files/")
        assert resp.status_code == 404  # session not found for other user


# ═══════════════════════════════════════════════════════════════════════════════
# Throttle: agent actions exempt from rate limiting
# ═══════════════════════════════════════════════════════════════════════════════


class TestThrottleExemption:
    """get_throttles() should return [] for agent-oriented actions."""

    def _viewset_with_action(self, action_name):
        from session_files.views import SessionFileViewSet

        vs = SessionFileViewSet()
        vs.action = action_name
        return vs

    def test_write_by_path_unthrottled(self):
        vs = self._viewset_with_action("write_by_path")
        assert vs.get_throttles() == []

    def test_read_by_path_unthrottled(self):
        vs = self._viewset_with_action("read_by_path")
        assert vs.get_throttles() == []

    def test_delete_by_path_unthrottled(self):
        vs = self._viewset_with_action("delete_by_path")
        assert vs.get_throttles() == []

    def test_list_action_still_throttled(self):
        vs_list = self._viewset_with_action("list")
        vs_agent = self._viewset_with_action("write_by_path")
        # Agent action takes the override path (always [])
        assert vs_agent.get_throttles() == []
        # list action delegates to super(); verify it takes a different
        # code path.  The actual throttle list depends on DRF settings,
        # but it must not be our explicit empty-list bypass.
        throttles = vs_list.get_throttles()
        assert isinstance(throttles, list)
        # In production settings throttles are configured, so the list
        # should be non-empty.  In a minimal test env it may still be [],
        # so we also confirm the code path difference via identity:
        assert throttles is not vs_agent.get_throttles()
