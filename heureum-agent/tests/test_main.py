# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Tests for main application.
"""

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.main import GracefulShutdown, app

client = TestClient(app)


def test_root() -> None:
    """Test root endpoint."""
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert "message" in data
    assert data["message"] == "Heureum Agent Service"


def test_health_check() -> None:
    """Test health check endpoint."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["version"] == "0.1.0"


def test_docs_available() -> None:
    """Test that API docs are available."""
    response = client.get("/docs")
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# GracefulShutdown
# ---------------------------------------------------------------------------


class TestGracefulShutdown:
    def test_initial_state(self):
        gs = GracefulShutdown()
        assert gs.shutting_down is False
        assert len(gs.active_tasks) == 0

    def test_track_and_remove(self):
        gs = GracefulShutdown()

        async def noop():
            pass

        loop = asyncio.new_event_loop()
        try:
            task = loop.create_task(noop())
            gs.track(task)
            assert task in gs.active_tasks
            loop.run_until_complete(task)
            # done callback should remove it
            assert task not in gs.active_tasks
        finally:
            loop.close()

    @pytest.mark.asyncio
    async def test_drain_cancels_pending(self):
        gs = GracefulShutdown()

        async def slow():
            await asyncio.sleep(100)

        task = asyncio.create_task(slow())
        gs.track(task)

        await gs._drain(timeout=0.1)
        assert task.cancelled() or task.done()

    @pytest.mark.asyncio
    async def test_drain_empty(self):
        gs = GracefulShutdown()
        # Should not raise with no tasks
        await gs._drain(timeout=0.1)
