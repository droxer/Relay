"""API modules read application state only through ``AppContext``.

``create_app`` builds the context once (``app.state.context``) and
``relay/api/deps.py`` is the one seam that reads it; a route reaching into
``request.app.state`` directly would bypass it and read state a test (or a
future startup change) has replaced on the context.
"""

from __future__ import annotations

from pathlib import Path

API_DIR = Path(__file__).resolve().parents[2] / "relay" / "api"
ALLOWED = {"deps.py"}  # paths relative to relay/api


def test_only_deps_reads_app_state() -> None:
    offenders = sorted(
        path.relative_to(API_DIR).as_posix()
        for path in API_DIR.rglob("*.py")
        if path.relative_to(API_DIR).as_posix() not in ALLOWED
        and "app.state" in path.read_text(encoding="utf-8")
    )
    assert API_DIR.is_dir()
    assert offenders == [], f"read application state through api/deps.py: {offenders}"
