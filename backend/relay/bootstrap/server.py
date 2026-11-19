"""Uvicorn process diagnostics; a signal is evidence, not a platform cause."""
from __future__ import annotations

import logging
import os
import signal
import sys
from types import FrameType
from typing import Any

import uvicorn
from uvicorn.main import STARTUP_FAILURE
from loguru import logger

try:
    import resource
except ImportError:  # Windows has no getrusage; keep the server portable.
    resource = None  # type: ignore[assignment]


def _process_fields() -> dict[str, Any]:
    fields: dict[str, Any] = {
        "pid": os.getpid(),
        "deployment_id": os.environ.get("RAILWAY_DEPLOYMENT_ID"),
        "revision": os.environ.get("RAILWAY_GIT_COMMIT_SHA"),
    }
    if resource is not None:
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        fields["max_rss_bytes"] = rss if sys.platform == "darwin" else rss * 1024
    return fields


class DiagnosticServer(uvicorn.Server):
    def handle_exit(self, sig: int, frame: FrameType | None) -> None:
        logger.info("Backend server received shutdown signal",
                    signal=signal.Signals(sig).name,
                    reason="signal; platform cause unknown", **_process_fields())
        super().handle_exit(sig, frame)


class ConnectionCallbackLogFilter(logging.Filter):
    """Keep single-use OAuth codes and state out of Uvicorn access logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) == 5 and isinstance(args[2], str):
            path = args[2].partition("?")[0]
            if path.startswith("/api/v1/connections/callback/"):
                record.args = (*args[:2], path, *args[3:])
        return True


def run_server(app: Any, **options: Any) -> None:
    server = DiagnosticServer(uvicorn.Config(app, **options))
    access_logger = logging.getLogger("uvicorn.access")
    callback_filter = ConnectionCallbackLogFilter()
    access_logger.addFilter(callback_filter)
    logger.info("Backend server process starting", **_process_fields())
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    finally:
        access_logger.removeFilter(callback_filter)
        logger.info("Backend server process exited", **_process_fields())
    # Match uvicorn.run: a failed ASGI startup must fail the container.
    if not server.started:
        sys.exit(STARTUP_FAILURE)
