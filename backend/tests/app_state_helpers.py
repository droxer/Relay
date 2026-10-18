"""Swap a piece of the application state a route reads, after ``create_app``.

Routes read the ``AppContext`` built once at startup (``app.state.context``),
so assigning ``app.state.<name>`` no longer reaches them; replace the field on
the context instead. The matching ``app.state`` attribute is kept in step so a
test that reads it back sees the same object.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from fastapi import FastAPI


def replace_app_context(app: FastAPI, **changes: Any) -> None:
    app.state.context = replace(app.state.context, **changes)
    for name, value in changes.items():
        setattr(app.state, name, value)
