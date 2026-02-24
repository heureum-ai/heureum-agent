import time

from django.test import TestCase
from rest_framework.test import APIClient

from .models import SubagentRun


class SweepStaleRunsTest(TestCase):
    """Tests for POST /api/v1/subagents/internal/runs/sweep/"""

    def setUp(self):
        self.client = APIClient()
        self.url = "/api/v1/subagents/internal/runs/sweep/"
        now = time.time()

        # Stale running record (started 2 hours ago)
        SubagentRun.objects.create(
            child_session_id="stale_1",
            root_session_id="root",
            parent_session_id="parent",
            task="stale task 1",
            started_at=now - 7200,
        )
        SubagentRun.objects.create(
            child_session_id="stale_2",
            root_session_id="root",
            parent_session_id="parent",
            task="stale task 2",
            started_at=now - 3600,
        )

        # Recent running record (started 1 minute ago) — should NOT be swept
        SubagentRun.objects.create(
            child_session_id="recent_running",
            root_session_id="root",
            parent_session_id="parent",
            task="recent task",
            started_at=now - 60,
        )

        # Already completed record — should NOT be swept
        SubagentRun.objects.create(
            child_session_id="completed_1",
            root_session_id="root",
            parent_session_id="parent",
            task="done task",
            status="completed",
            started_at=now - 7200,
            completed_at=now - 3600,
        )

    def test_sweeps_stale_running_records(self):
        resp = self.client.post(self.url, {"stale_seconds": 600}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["swept_count"], 2)

        # Verify status changed to timeout
        for sid in ("stale_1", "stale_2"):
            run = SubagentRun.objects.get(child_session_id=sid)
            self.assertEqual(run.status, "timeout")
            self.assertIsNotNone(run.completed_at)
            self.assertIn("stale", run.result_summary.lower())

    def test_keeps_recent_running_records(self):
        self.client.post(self.url, {"stale_seconds": 600}, format="json")

        run = SubagentRun.objects.get(child_session_id="recent_running")
        self.assertEqual(run.status, "running")

    def test_keeps_completed_records(self):
        self.client.post(self.url, {"stale_seconds": 600}, format="json")

        run = SubagentRun.objects.get(child_session_id="completed_1")
        self.assertEqual(run.status, "completed")

    def test_default_stale_seconds(self):
        """Default stale_seconds=600 is used when not provided."""
        resp = self.client.post(self.url, {}, format="json")
        self.assertEqual(resp.status_code, 200)
        # Both stale records should be swept with default 600s
        self.assertEqual(resp.json()["swept_count"], 2)

    def test_custom_stale_seconds(self):
        """Only records older than custom threshold are swept."""
        # Use 5000s — only stale_1 (7200s ago) is older
        resp = self.client.post(self.url, {"stale_seconds": 5000}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["swept_count"], 1)

        self.assertEqual(
            SubagentRun.objects.get(child_session_id="stale_1").status, "timeout"
        )
        self.assertEqual(
            SubagentRun.objects.get(child_session_id="stale_2").status, "running"
        )

    def test_no_stale_records(self):
        """Returns swept_count=0 when nothing to sweep."""
        # Use very large stale_seconds so nothing qualifies
        resp = self.client.post(self.url, {"stale_seconds": 999999}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["swept_count"], 0)
