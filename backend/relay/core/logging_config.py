from __future__ import annotations

import logging
import os
import sys
from typing import Any

from loguru import logger

from .repeat_log import RepeatGate

# Every worker tick of a periodic check logs "deferred", "Starting job" and
# "ended with status: Success" at INFO: ~98% of the worker's log volume.
# Start, stop, and failure records keep their level.
ROUTINE_JOB_ACTIONS = frozenset({
    "periodic_task_deferred", "jobs_deferred", "loaded_job_info", "start_job", "job_success",
})
# Daemons beat, poll, and report several times a second; their access lines
# were ~75% of the backend's volume. The routes log their own failures.
DAEMON_WIRE_PATH = "/daemon-nodes/"
_access_failures = RepeatGate()


def _routed(record: logging.LogRecord) -> tuple[str | int, str]:
    """The loguru level and message a stdlib record is written at."""
    try:
        level: str | int = logger.level(record.levelname).name
    except ValueError:
        level = record.levelno
    message = record.getMessage()
    if record.levelno != logging.INFO:
        return level, message
    if record.name.startswith("procrastinate") and getattr(record, "action", None) in ROUTINE_JOB_ACTIONS:
        return "DEBUG", message
    if record.name == "uvicorn.access" and isinstance(record.args, tuple) and len(record.args) == 5:
        _client, method, path, _version, status = record.args
        if not isinstance(path, str) or DAEMON_WIRE_PATH not in path:
            return level, message
        if not isinstance(status, int) or status < 400:
            return "DEBUG", message
        occurrence = _access_failures.observe((method, path.split("?", 1)[0], status))
        if not occurrence.report:
            return "DEBUG", message
        if not occurrence.first:
            message = f"{message} (repeated {occurrence.count} times in this window)"
    return level, message


class InterceptHandler(logging.Handler):
    """Route standard-library logging records into loguru."""

    def emit(self, record: logging.LogRecord) -> None:
        level, message = _routed(record)

        # Skip this handler frame and any frames inside the standard logging module
        # so the reported source file/line points at the original caller.
        frame, depth = logging.currentframe(), 2
        while frame and (frame.f_code.co_filename == logging.__file__ or frame.f_code.co_filename == __file__):
            frame = frame.f_back  # type: ignore[assignment]
            depth += 1

        logger.opt(depth=depth, exception=record.exc_info).log(level, message)


CONTEXT_KEYS = frozenset({
    "session_id", "run_id", "request_id", "node_id", "sandbox_id", "command_id", "tool",
    "event_type", "error_type", "repeat_count", "transient",
})


def _format_record(record: Any) -> str:
    # Operational identifiers are useful; arbitrary bound payloads can contain
    # credentials or user content and must not be dumped into production logs.
    record["extra"]["relay_context"] = {
        key: value for key, value in record["extra"].items()
        if key in CONTEXT_KEYS
    }
    return "{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {name}:{function}:{line} - {message} | {extra[relay_context]}\n{exception}"


def setup_logging(
    *,
    level: str | None = None,
    sink: Any = None,
) -> None:
    """Configure loguru for the Relay backend.

    Reads ``RELAY_LOG_LEVEL`` from the environment (default ``INFO``) and
    redirects the standard-library ``logging`` module into loguru so that
    uvicorn/fastapi/alembic output is unified.
    """
    level = (level or os.environ.get("RELAY_LOG_LEVEL", "INFO")).upper()

    logger.remove()
    options: dict[str, Any] = {
        "level": level,
        "format": _format_record,
        "colorize": False,
        # No local-variable dumps (they can hold credentials) and no frames
        # above the catch point: a traceback stays a handful of lines.
        "diagnose": False,
        "backtrace": False,
    }
    if sink is not None:
        logger.add(sink, **options)
    else:
        logger.add(sys.stdout, filter=lambda record: record["level"].no < 40, **options)
        logger.add(sys.stderr, filter=lambda record: record["level"].no >= 40, **options)

    logging.basicConfig(handlers=[InterceptHandler()], level=level)

    # Propagate logs from third-party packages through the intercept handler.
    for module in ("uvicorn", "uvicorn.access", "uvicorn.error", "fastapi", "alembic"):
        module_logger = logging.getLogger(module)
        module_logger.handlers = [InterceptHandler()]
        module_logger.propagate = False
