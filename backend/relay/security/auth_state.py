"""The engine and tables every ``DatabaseAccountAuthStore`` mixin shares."""

from __future__ import annotations

from threading import RLock
from typing import Any, TYPE_CHECKING


class AuthStoreState:
    metadata: Any
    departments: Any
    users: Any
    accounts: Any
    sessions: Any
    password_resets: Any
    engine: Any
    session_ttl_seconds: int
    _bootstrap_lock: RLock

    if TYPE_CHECKING:
        # Methods one mixin calls on another, declared so each type-checks alone.
        def _account_pk(self, conn: Any, account_id: str) -> str:
            ...

        def _ensure_department(
            self,
            conn: Any,
            department_id: str,
            *,
            name: str | None = None,
            parent_department_id: str | None = None,
        ) -> dict[str, Any]:
            ...

        def _ensure_user(
            self,
            conn: Any,
            user_id: str | None,
            *,
            handle: str | None = None,
            display_name: str | None = None,
            email: str | None = None,
            department_id: str | None = None,
            department_name: str | None = None,
            max_local_computers: int | None = None,
        ) -> dict[str, Any]:
            ...
