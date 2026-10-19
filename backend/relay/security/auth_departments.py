"""Departments: ensuring one (and its parent) and listing them."""

from __future__ import annotations

from datetime import datetime, UTC
from typing import Any

from sqlalchemy import (
    insert,
    select,
    update,
)

from .auth_rows import department_to_row, row_to_department
from .auth_state import AuthStoreState
from .entity_ids import database_id_for_reference
from ..persistence.db_time import format_db_time
from ..persistence.engine import store_transaction


class AuthDepartments(AuthStoreState):
    def ensure_department(
        self,
        department_id: str,
        *,
        name: str | None = None,
        parent_department_id: str | None = None,
    ) -> dict[str, Any]:
        department_id = department_id.strip()
        if not department_id:
            raise ValueError("departmentId is required.")
        with store_transaction(self.engine) as conn:
            return self._ensure_department(
                conn,
                department_id,
                name=name,
                parent_department_id=parent_department_id,
            )

    def list_departments(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = (
                conn.execute(select(self.departments).order_by(self.departments.c.name))
                .mappings()
                .all()
            )
        return [row_to_department(row) for row in rows]

    def _ensure_department(
        self,
        conn: Any,
        department_id: str,
        *,
        name: str | None = None,
        parent_department_id: str | None = None,
    ) -> dict[str, Any]:
        requested_department_id = department_id.strip()
        department_id = database_id_for_reference(requested_department_id, "department")
        name = name.strip() if name else requested_department_id
        parent_department_id = (
            parent_department_id.strip() if parent_department_id else None
        )
        now = datetime.now(UTC)
        parent = (
            self._ensure_department(conn, parent_department_id)
            if parent_department_id
            else None
        )
        parent_department_pk = parent["id"] if parent else None
        row = (
            conn.execute(
                select(self.departments).where(self.departments.c.id == department_id)
            )
            .mappings()
            .first()
        )
        if row:
            department_pk = row["id"]
            patch: dict[str, Any] = {"updated_at": now}
            if name:
                patch["name"] = name
            if parent_department_pk:
                patch["parent_department_id"] = parent_department_pk
            if len(patch) > 1:
                conn.execute(
                    update(self.departments)
                    .where(self.departments.c.id == department_pk)
                    .values(**patch)
                )
                return {
                    **row_to_department(row),
                    "name": patch.get("name", row["name"]),
                    "parentDepartmentId": patch.get(
                        "parent_department_id",
                        str(row["parent_department_id"])
                        if row["parent_department_id"]
                        else None,
                    ),
                    "updatedAt": format_db_time(now),
                }
            return row_to_department(row)

        department = {
            "id": department_id,
            "name": name,
            "parentDepartmentId": parent_department_pk,
            "createdAt": format_db_time(now),
            "updatedAt": format_db_time(now),
        }
        conn.execute(
            insert(self.departments).values(
                **department_to_row(
                    department, parent_department_pk=parent_department_pk
                )
            )
        )
        return department
