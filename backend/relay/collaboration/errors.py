"""The one error a collaboration round refuses with."""

from __future__ import annotations


class CollaborationError(ValueError):
    def __init__(self, code: str, message: str | None = None, *, status: int = 409):
        self.code = code
        self.status = status
        super().__init__(message or code)
