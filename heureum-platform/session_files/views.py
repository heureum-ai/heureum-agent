# Copyright (c) 2026 Heureum AI. All rights reserved.

import mimetypes

from django.core.files.storage import default_storage
from django.http import FileResponse
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.viewsets import ViewSet

from chat_messages.models import Session
from .models import SessionFile
from .serializers import SessionFileListSerializer, SessionFileSerializer
from .storage import SessionFileStorage


def _get_session(session_id, request):
    """Get session, checking ownership for authenticated users."""
    try:
        session = Session.objects.get(session_id=session_id)
    except Session.DoesNotExist:
        return None
    if request.user.is_authenticated and session.user and session.user != request.user:
        return None
    return session


class SessionFileViewSet(ViewSet):
    """REST API for session file operations."""

    _UNTHROTTLED_ACTIONS = frozenset({"write_by_path", "read_by_path", "delete_by_path"})

    def get_throttles(self):
        if self.action in self._UNTHROTTLED_ACTIONS:
            return []
        return super().get_throttles()

    def list(self, request, session_id=None):
        """List files in session, optional ?path= prefix filter."""
        session = _get_session(session_id, request)
        if not session:
            return Response({"error": "Session not found"}, status=status.HTTP_404_NOT_FOUND)

        files = SessionFile.objects.filter(session=session)
        path_prefix = request.query_params.get("path", "")
        if path_prefix:
            files = files.filter(path__startswith=path_prefix)
        return Response(SessionFileListSerializer(files, many=True).data)

    def create(self, request, session_id=None):
        """Upload a file (multipart/form-data: file + path)."""
        session = _get_session(session_id, request)
        if not session:
            return Response({"error": "Session not found"}, status=status.HTTP_404_NOT_FOUND)

        uploaded_file = request.FILES.get("file")
        if not uploaded_file:
            return Response({"error": "No file provided"}, status=status.HTTP_400_BAD_REQUEST)

        if uploaded_file.size > SessionFileStorage.MAX_FILE_SIZE:
            return Response(
                {"error": f"File too large (max {SessionFileStorage.MAX_FILE_SIZE // 1024 // 1024}MB)"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        path = request.data.get("path", uploaded_file.name)
        try:
            path = SessionFileStorage.validate_path(path)
        except ValueError as e:
            return Response({"error": str(e)}, status=status.HTTP_400_BAD_REQUEST)

        content = uploaded_file.read()
        content_type = uploaded_file.content_type or mimetypes.guess_type(path)[0] or "application/octet-stream"
        is_text = SessionFileStorage.is_text_file(path, content_type)

        text_content = None
        if is_text and len(content) <= SessionFileStorage.TEXT_DB_THRESHOLD:
            try:
                text_content = content.decode("utf-8")
            except UnicodeDecodeError:
                is_text = False

        SessionFileStorage.save(session_id, path, content)

        file_obj, created = SessionFile.objects.update_or_create(
            session=session,
            path=path,
            defaults={
                "content_type": content_type,
                "size": len(content),
                "is_text": is_text,
                "text_content": text_content,
                "created_by": "user",
            },
        )

        return Response(
            SessionFileSerializer(file_obj).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    def retrieve(self, request, session_id=None, pk=None):
        """Get file metadata + text_content."""
        session = _get_session(session_id, request)
        if not session:
            return Response({"error": "Session not found"}, status=status.HTTP_404_NOT_FOUND)

        try:
            file_obj = SessionFile.objects.get(id=pk, session=session)
        except SessionFile.DoesNotExist:
            return Response({"error": "File not found"}, status=status.HTTP_404_NOT_FOUND)

        return Response(SessionFileSerializer(file_obj).data)

    def update(self, request, session_id=None, pk=None):
        """Update text content of a text file."""
        session = _get_session(session_id, request)
        if not session:
            return Response({"error": "Session not found"}, status=status.HTTP_404_NOT_FOUND)

        try:
            file_obj = SessionFile.objects.get(id=pk, session=session)
        except SessionFile.DoesNotExist:
            return Response({"error": "File not found"}, status=status.HTTP_404_NOT_FOUND)

        if not file_obj.is_text:
            return Response({"error": "Cannot edit binary files"}, status=status.HTTP_400_BAD_REQUEST)

        text_content = request.data.get("text_content")
        if text_content is None:
            return Response({"error": "text_content is required"}, status=status.HTTP_400_BAD_REQUEST)

        content_bytes = text_content.encode("utf-8")
        SessionFileStorage.save(session_id, file_obj.path, content_bytes)

        file_obj.text_content = text_content if len(content_bytes) <= SessionFileStorage.TEXT_DB_THRESHOLD else None
        file_obj.size = len(content_bytes)
        file_obj.save()

        return Response(SessionFileSerializer(file_obj).data)

    def destroy(self, request, session_id=None, pk=None):
        """Delete a file."""
        session = _get_session(session_id, request)
        if not session:
            return Response({"error": "Session not found"}, status=status.HTTP_404_NOT_FOUND)

        try:
            file_obj = SessionFile.objects.get(id=pk, session=session)
        except SessionFile.DoesNotExist:
            return Response({"error": "File not found"}, status=status.HTTP_404_NOT_FOUND)

        SessionFileStorage.delete(session_id, file_obj.path)
        file_obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["get"])
    def download(self, request, session_id=None, pk=None):
        """Stream raw file content."""
        session = _get_session(session_id, request)
        if not session:
            return Response({"error": "Session not found"}, status=status.HTTP_404_NOT_FOUND)

        try:
            file_obj = SessionFile.objects.get(id=pk, session=session)
        except SessionFile.DoesNotExist:
            return Response({"error": "File not found"}, status=status.HTTP_404_NOT_FOUND)

        blob_name = SessionFileStorage._blob_name(session_id, file_obj.path)
        try:
            f = default_storage.open(blob_name, "rb")
        except FileNotFoundError:
            return Response({"error": "File not found in storage"}, status=status.HTTP_404_NOT_FOUND)

        return FileResponse(
            f,
            content_type=file_obj.content_type,
            filename=file_obj.filename,
        )

    # --- Agent-oriented endpoints (path-based) ---

    @action(detail=False, methods=["get"], url_path="read")
    def read_by_path(self, request, session_id=None):
        """Agent-oriented: read file by path."""
        path = request.query_params.get("path", "")
        if not path:
            return Response({"error": "path parameter is required"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            file_obj = SessionFile.objects.get(session__session_id=session_id, path=path)
        except SessionFile.DoesNotExist:
            return Response({"error": f"File not found: {path}"}, status=status.HTTP_404_NOT_FOUND)

        if file_obj.text_content is not None:
            return Response({"path": path, "content": file_obj.text_content, "size": file_obj.size})

        # Fall back to reading from disk
        try:
            content = SessionFileStorage.read(session_id, path)
            if file_obj.is_text:
                return Response({"path": path, "content": content.decode("utf-8"), "size": file_obj.size})
            return Response({"path": path, "content": "(binary file)", "size": file_obj.size})
        except FileNotFoundError:
            return Response({"error": f"File not found on disk: {path}"}, status=status.HTTP_404_NOT_FOUND)

    @action(detail=False, methods=["post"], url_path="write")
    def write_by_path(self, request, session_id=None):
        """Agent-oriented: write file by path (creates or overwrites)."""
        path = request.data.get("path", "")
        content = request.data.get("content", "")
        created_by = request.data.get("created_by", "agent")

        if not path:
            return Response({"error": "path is required"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            path = SessionFileStorage.validate_path(path)
        except ValueError as e:
            return Response({"error": str(e)}, status=status.HTTP_400_BAD_REQUEST)

        # Ensure session exists (auto-create for subagent sessions)
        session, _ = Session.objects.get_or_create(session_id=session_id)

        content_bytes = content.encode("utf-8")
        content_type = mimetypes.guess_type(path)[0] or "text/plain"
        is_text = True
        text_content = content if len(content_bytes) <= SessionFileStorage.TEXT_DB_THRESHOLD else None

        SessionFileStorage.save(session_id, path, content_bytes)

        file_obj, created = SessionFile.objects.update_or_create(
            session=session,
            path=path,
            defaults={
                "content_type": content_type,
                "size": len(content_bytes),
                "is_text": is_text,
                "text_content": text_content,
                "created_by": created_by,
            },
        )

        return Response(
            SessionFileSerializer(file_obj).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )

    @action(detail=False, methods=["delete"], url_path="delete-by-path")
    def delete_by_path(self, request, session_id=None):
        """Agent-oriented: delete file by path."""
        path = request.query_params.get("path", "")
        if not path:
            return Response({"error": "path parameter is required"}, status=status.HTTP_400_BAD_REQUEST)

        try:
            file_obj = SessionFile.objects.get(session__session_id=session_id, path=path)
        except SessionFile.DoesNotExist:
            return Response({"error": f"File not found: {path}"}, status=status.HTTP_404_NOT_FOUND)

        SessionFileStorage.delete(session_id, file_obj.path)
        file_obj.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
