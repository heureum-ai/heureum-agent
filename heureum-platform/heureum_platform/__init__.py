# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Heureum Platform - Django proxy and message storage system."""
__version__ = "0.1.0"


def _enable_wal(sender, connection, **kwargs):
    """Enable WAL mode for SQLite to support concurrent reads/writes."""
    if connection.vendor == "sqlite":
        cursor = connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL;")
        cursor.execute("PRAGMA synchronous=NORMAL;")


from django.db.backends.signals import connection_created  # noqa: E402

connection_created.connect(_enable_wal)
