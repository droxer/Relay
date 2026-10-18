from __future__ import annotations

from typing import Any

__all__ = [
    "DEFAULT_RELAY_DATA_DIR",
    "DaemonNodeRegistry",
    "DatabaseDaemonStore",
    "DatabaseSessionStore",
    "DatabaseTaskStore",
    "DatabaseUserAuthStore",
    "ServerDaemonNodeBackend",
    "SessionController",
    "create_app",
]


def __getattr__(name: str) -> Any:
    if name == "create_app":
        from .app import create_app

        return create_app
    if name == "SessionController":
        from .sessions.controller import SessionController

        return SessionController
    if name in {"DaemonNodeRegistry", "ServerDaemonNodeBackend"}:
        from .daemon_registry.registry import DaemonNodeRegistry
        from .daemon_registry.node_backend import ServerDaemonNodeBackend

        return {"DaemonNodeRegistry": DaemonNodeRegistry, "ServerDaemonNodeBackend": ServerDaemonNodeBackend}[name]
    if name in {
        "DEFAULT_RELAY_DATA_DIR",
        "DatabaseDaemonStore",
        "DatabaseSessionStore",
        "DatabaseTaskStore",
    }:
        from .persistence.stores import (
            DEFAULT_RELAY_DATA_DIR,
            DatabaseDaemonStore,
            DatabaseSessionStore,
            DatabaseTaskStore,
        )

        return {
            "DEFAULT_RELAY_DATA_DIR": DEFAULT_RELAY_DATA_DIR,
            "DatabaseDaemonStore": DatabaseDaemonStore,
            "DatabaseSessionStore": DatabaseSessionStore,
            "DatabaseTaskStore": DatabaseTaskStore,
        }[name]
    if name == "DatabaseUserAuthStore":
        from .security.auth import DatabaseAccountAuthStore

        return DatabaseAccountAuthStore
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
