"""Users: resolving a handle or id, ensuring, patching, listing, soft-deleting."""

from __future__ import annotations

from datetime import datetime, UTC
from typing import Any

from loguru import logger
from sqlalchemy import (
    insert,
    select,
    update,
)

from .auth_rows import row_to_department, row_to_user, user_to_row, user_with_department
from .auth_state import AuthStoreState
from .entity_ids import USER_ENTITY_KIND, database_id_for_reference, normalize_database_id
from .user_handles import slugify_handle
from ..core.ids import new_database_id
from ..persistence.db_time import format_db_time
from ..persistence.engine import store_transaction


class AuthUsers(AuthStoreState):
    def resolve_user_id(self, user_id: str) -> str:
        """The id a `user_id` (a UUID or a handle) lands on in this store.

        Callers that ask "does this user already exist?" before creating one
        must compare this form, or the check silently passes on a live
        collision. The handle column is consulted first: rows backfilled by the
        migration carry a handle whose uuid5 is not their id, so the
        deterministic mapping alone would miss a real collision."""
        requested = (user_id or "").strip()
        if not requested:
            return ""
        if not normalize_database_id(requested):
            with store_transaction(self.engine) as conn:
                row = (
                    conn.execute(
                        select(self.users.c.id).where(
                            self.users.c.handle == requested.lower()
                        )
                    )
                    .mappings()
                    .first()
                )
                stored = None if row else self._stored_user_id(conn, requested)
            if row:
                return str(row["id"])
            if stored:
                return stored
        return database_id_for_reference(requested, USER_ENTITY_KIND)

    def ensure_user(
        self,
        user_id: str,
        *,
        display_name: str | None = None,
        email: str | None = None,
        department_id: str | None = None,
        department_name: str | None = None,
        max_local_computers: int | None = None,
    ) -> dict[str, Any]:
        requested_user_id = user_id.strip()
        if not requested_user_id:
            raise ValueError("userId is required.")
        with store_transaction(self.engine) as conn:
            return self._ensure_user(
                conn,
                self._stored_user_id(conn, requested_user_id)
                or database_id_for_reference(requested_user_id, USER_ENTITY_KIND),
                # The caller's user_id IS the handle when it is not already
                # a UUID — that is the only place the spelling survives.
                handle=None
                if normalize_database_id(requested_user_id)
                else requested_user_id,
                display_name=display_name or requested_user_id,
                email=email,
                department_id=department_id,
                department_name=department_name,
                max_local_computers=max_local_computers,
            )

    def update_user(
        self,
        user_id: str,
        *,
        display_name: str | None = None,
        email: str | None = None,
        max_local_computers: int | None = None,
        clear_max_local_computers: bool = False,
    ) -> dict[str, Any]:
        """Patch a user's profile. Absent arguments leave a field alone.

        `max_local_computers=None` therefore cannot mean "clear the override" —
        that is what `clear_max_local_computers` is for, since clearing is a
        distinct intent ("inherit the org default") from leaving it untouched.
        """
        user_id = (user_id or "").strip()
        if not user_id:
            raise ValueError("userId is required.")
        if clear_max_local_computers and max_local_computers is not None:
            raise ValueError("maxLocalComputers cannot be both cleared and set.")
        now = datetime.now(UTC)
        patch: dict[str, Any] = {}
        if display_name is not None:
            display_name = display_name.strip()
            if not display_name:
                raise ValueError("displayName cannot be empty.")
            patch["display_name"] = display_name
        if email is not None:
            patch["email"] = email.strip() or None
        if clear_max_local_computers:
            patch["max_local_computers"] = None
        elif max_local_computers is not None:
            patch["max_local_computers"] = max_local_computers
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.users).where(self.users.c.id == user_id)
                )
                .mappings()
                .first()
            )
            if not row or row.get("deleted_at"):
                raise KeyError(user_id)
            if not patch:
                return row_to_user(row)
            conn.execute(
                update(self.users)
                .where(self.users.c.id == row["id"])
                .values(**patch, updated_at=now)
            )
            updated = (
                conn.execute(
                    select(self.users).where(self.users.c.id == row["id"])
                )
                .mappings()
                .first()
            )
        logger.info("User updated", user_id=user_id)
        return row_to_user(updated)

    def list_users(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            department_rows = conn.execute(select(self.departments)).mappings().all()
            departments = {
                str(row["id"]): row_to_department(row) for row in department_rows
            }
            rows = (
                conn.execute(
                    select(self.users)
                    .where(self.users.c.deleted_at.is_(None))
                    .order_by(self.users.c.created_at, self.users.c.id)
                )
                .mappings()
                .all()
            )
        return [
            user_with_department(row_to_user(row), departments) for row in rows
        ]

    def soft_delete_user(self, user_id: str) -> dict[str, Any]:
        user_id = (user_id or "").strip()
        if not user_id:
            raise ValueError("userId is required.")
        now = datetime.now(UTC)
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.users).where(self.users.c.id == user_id)
                )
                .mappings()
                .first()
            )
            if not row:
                raise KeyError(user_id)
            if row.get("deleted_at"):
                raise ValueError("User is already deleted.")
            conn.execute(
                update(self.users)
                .where(self.users.c.id == row["id"])
                .values(deleted_at=now, updated_at=now)
            )
        logger.info("User soft-deleted", user_id=user_id)
        return {"id": user_id, "deletedAt": format_db_time(now)}

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
        now = datetime.now(UTC)
        department_id = department_id.strip() if department_id else None
        department = (
            self._ensure_department(conn, department_id, name=department_name)
            if department_id
            else None
        )
        department_pk = department["id"] if department else None
        user_id = self._stored_user_id(conn, user_id)
        row = None
        if user_id:
            row = (
                conn.execute(
                    select(self.users).where(self.users.c.id == user_id)
                )
                .mappings()
                .first()
            )
        if row:
            user_pk = row["id"]
            patch: dict[str, Any] = {"updated_at": now}
            if row.get("deleted_at"):
                patch["deleted_at"] = None
            # Only ever fills a blank — an existing handle is the user's
            # identity and is not rewritten by a later ensure — and only when
            # the handle is still free, since the column is unique and an
            # ensure has no business failing the whole request over a name.
            if handle and not row.get("handle") and self._handle_is_free(conn, handle):
                patch["handle"] = handle
            if display_name:
                patch["display_name"] = display_name
            if email:
                patch["email"] = email
            if department_pk:
                patch["department_id"] = department_pk
            if max_local_computers is not None:
                patch["max_local_computers"] = max_local_computers
            if len(patch) > 1:
                conn.execute(
                    update(self.users)
                    .where(self.users.c.id == user_pk)
                    .values(**patch)
                )
                return {
                    **row_to_user(row),
                    **({"handle": patch["handle"]} if "handle" in patch else {}),
                    **({"displayName": display_name} if display_name else {}),
                    **({"email": email} if email else {}),
                    **({"departmentId": department_pk} if department_pk else {}),
                    **(
                        {"maxLocalComputers": max_local_computers}
                        if max_local_computers is not None
                        else {}
                    ),
                    "updatedAt": format_db_time(now),
                }
            return row_to_user(row)

        candidate = handle or slugify_handle(display_name) or None
        user = {
            "id": user_id or new_database_id(),
            "handle": candidate if candidate and self._handle_is_free(conn, candidate) else None,
            "displayName": display_name or user_id,
            "email": email,
            "departmentId": department_pk,
            "maxLocalComputers": max_local_computers,
            "createdAt": format_db_time(now),
            "updatedAt": format_db_time(now),
        }
        conn.execute(
            insert(self.users).values(
                **user_to_row(user, department_pk=department_pk)
            )
        )
        return user

    def _stored_user_id(self, conn: Any, user_id: str | None) -> str | None:
        """``user_id`` as the users table keys it, or None.

        A UUID as given. Otherwise only a user imported from the retired file
        store on SQLite, which kept its handle-shaped id verbatim so the rows
        that reference it still match (PostgreSQL ids are always UUIDs)."""
        normalized = normalize_database_id(user_id)
        if normalized or not user_id or self.engine.dialect.name != "sqlite":
            return normalized
        stored = conn.scalar(select(self.users.c.id).where(self.users.c.id == user_id.strip()))
        return str(stored) if stored is not None else None

    def _handle_is_free(self, conn: Any, handle: str) -> bool:
        return (
            conn.execute(
                select(self.users.c.id).where(self.users.c.handle == handle)
            )
            .mappings()
            .first()
            is None
        )
