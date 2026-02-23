from django.db import models


class SubagentRun(models.Model):
    """Sub-agent execution metadata."""

    child_session_id = models.CharField(max_length=64, unique=True)
    root_session_id = models.CharField(max_length=64, db_index=True)
    parent_session_id = models.CharField(max_length=64, db_index=True)
    task = models.TextField()
    system_prompt = models.TextField(blank=True)
    status = models.CharField(max_length=20, default="running")
    result_summary = models.TextField(blank=True)
    started_at = models.FloatField()
    completed_at = models.FloatField(null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.child_session_id} ({self.status})"


class SubagentMessage(models.Model):
    """Sub-agent conversation message (persisted individually in real-time)."""

    run = models.ForeignKey(
        SubagentRun, on_delete=models.CASCADE, related_name="messages"
    )
    seq = models.PositiveIntegerField()
    role = models.CharField(max_length=20)
    content = models.TextField()
    tool_call_id = models.CharField(max_length=64, blank=True, default="")
    tool_name = models.CharField(max_length=128, blank=True, default="")
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("run", "seq")]
        ordering = ["seq"]

    def __str__(self):
        return f"run={self.run.child_session_id} seq={self.seq} role={self.role}"
