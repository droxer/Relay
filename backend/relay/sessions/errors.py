"""Why a ``SessionController`` refuses to change a thread."""

from __future__ import annotations


class SessionArchivedError(Exception):
    def __init__(self, session_id: str) -> None:
        super().__init__(f"Session {session_id} is archived.")
        self.session_id = session_id


class SessionRunInFlightError(Exception):
    def __init__(self, session_id: str) -> None:
        super().__init__(f"Session {session_id} has a run in flight.")
        self.session_id = session_id
