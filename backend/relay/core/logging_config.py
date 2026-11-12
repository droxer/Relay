from __future__ import annotations

import logging
import os
import sys
from typing import Any

from loguru import logger


class InterceptHandler(logging.Handler):
    """Route standard-library logging records into loguru."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = logger.level(record.levelname).name
        except ValueError:
            level = str(record.levelno)

        # Skip this handler frame and any frames inside the standard logging module
        # so the reported source file/line points at the original caller.
        frame, depth = logging.currentframe(), 2
        while frame and (frame.f_code.co_filename == logging.__file__ or frame.f_code.co_filename == __file__):
            frame = frame.f_back  # type: ignore[assignment]
            depth += 1

        logger.opt(depth=depth, exception=record.exc_info).log(
            level,
            record.getMessage(),
        )


def _format_record(record: Any) -> str:
    # Operational identifiers are useful; arbitrary bound payloads can contain
    # credentials or user content and must not be dumped into production logs.
    record["extra"]["relay_context"] = {
        key: value for key, value in record["extra"].items()
        if key in {"session_id", "run_id", "request_id", "node_id", "sandbox_id", "command_id", "tool"}
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
        "diagnose": False,
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
