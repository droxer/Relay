"""Org-wide admin settings.

A single row, database-only. The backend always has a database engine (sessions
and tasks require one), so a second file-backed implementation would only add a
divergent code path to keep in sync.
"""

from __future__ import annotations

import ipaddress
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    Integer,
    Table,
    Text,
    insert,
    select,
    update,
)

from .store_common import (
    _format_iso,
    create_all_tables,
    json_type,
    shared_engine,
    store_transaction,
)
from .store_common import (
    metadata as shared_metadata,
)

# The whole table is one row; the id is a constant so concurrent writers
# contend on a single primary key rather than racing to insert siblings.
SETTINGS_ROW_ID = "org"

DEFAULT_MAX_LOCAL_COMPUTERS = 3
# 0 means "this employee may enroll no personal machine". The ceiling exists so
# a typo cannot turn the limit into an accidental no-op; an admin who wants no
# practical cap sets the ceiling.
MIN_MAX_LOCAL_COMPUTERS = 0
MAX_MAX_LOCAL_COMPUTERS = 50

# How many times a task may be re-dispatched because its last round reported it
# unfinished. One means "no automatic continuation": the first round is not a
# continuation, so the cap only bounds the rounds that follow.
DEFAULT_MAX_TASK_ROUNDS = 5
MIN_MAX_TASK_ROUNDS = 1
MAX_MAX_TASK_ROUNDS = 50


class OrgSettingsValidationError(ValueError):
    pass


def normalize_skill_import_hosts(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > 32:
        raise OrgSettingsValidationError("skillImportAllowedHosts must be a list of at most 32 DNS hostnames.")
    hosts = set()
    for host in value:
        if not isinstance(host, str) or len(host) > 253:
            raise OrgSettingsValidationError("Invalid skill import hostname.")
        host = host.lower()
        if "." not in host or any(
            re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) is None
            for label in host.split(".")
        ):
            raise OrgSettingsValidationError("Invalid skill import hostname.")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            hosts.add(host)
        else:
            raise OrgSettingsValidationError("Skill import hosts must be DNS hostnames, not IP addresses.")
    return sorted(hosts)


def normalize_max_local_computers(value: Any) -> int:
    """Coerce an API-supplied limit, rejecting anything outside the range."""
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise OrgSettingsValidationError(
            "maxLocalComputers must be a whole number."
        )
    try:
        limit = int(value)
    except (TypeError, ValueError) as error:
        raise OrgSettingsValidationError(
            "maxLocalComputers must be a whole number."
        ) from error
    if limit < MIN_MAX_LOCAL_COMPUTERS or limit > MAX_MAX_LOCAL_COMPUTERS:
        raise OrgSettingsValidationError(
            "maxLocalComputers must be between "
            f"{MIN_MAX_LOCAL_COMPUTERS} and {MAX_MAX_LOCAL_COMPUTERS}."
        )
    return limit


def normalize_max_task_rounds(value: Any) -> int:
    """Coerce an API-supplied round cap, rejecting anything outside the range."""
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise OrgSettingsValidationError("maxTaskRounds must be a whole number.")
    try:
        rounds = int(value)
    except (TypeError, ValueError) as error:
        raise OrgSettingsValidationError(
            "maxTaskRounds must be a whole number."
        ) from error
    if rounds < MIN_MAX_TASK_ROUNDS or rounds > MAX_MAX_TASK_ROUNDS:
        raise OrgSettingsValidationError(
            f"maxTaskRounds must be between {MIN_MAX_TASK_ROUNDS} and "
            f"{MAX_MAX_TASK_ROUNDS}."
        )
    return rounds


class DatabaseOrgSettingsStore:
    metadata = shared_metadata

    settings = Table(
        "org_settings",
        metadata,
        Column("id", Text, primary_key=True),
        Column(
            "max_local_computers_per_employee",
            Integer,
            nullable=False,
        ),
        Column(
            "max_task_rounds",
            Integer,
            nullable=False,
            server_default=str(DEFAULT_MAX_TASK_ROUNDS),
        ),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        Column("skill_import_allowed_hosts", json_type(), nullable=False, server_default='["github.com"]'),
        CheckConstraint(
            "max_task_rounds >= 1",
            name="ck_org_settings_max_task_rounds_positive",
        ),
        CheckConstraint(
            "max_local_computers_per_employee >= 0",
            name="ck_org_settings_max_local_computers_non_negative",
        ),
    )

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def get_settings(self) -> dict[str, Any]:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.settings).where(self.settings.c.id == SETTINGS_ROW_ID)
                )
                .mappings()
                .first()
            )
        if not row:
            # Absent row is the shipped default rather than an error: a fresh
            # install has never opened the settings screen.
            return {
                "maxLocalComputersPerEmployee": DEFAULT_MAX_LOCAL_COMPUTERS,
                "maxTaskRounds": DEFAULT_MAX_TASK_ROUNDS,
                "skillImportAllowedHosts": ["github.com"],
                "updatedAt": None,
            }
        return _row_to_settings(row)

    def update_settings(
        self,
        *,
        max_local_computers_per_employee: int | None = None,
        max_task_rounds: int | None = None,
        skill_import_allowed_hosts: list[str] | None = None,
    ) -> dict[str, Any]:
        # Each field is optional so a caller can change one without having to
        # read and resend the other, which would race a concurrent edit.
        current = self.get_settings()
        limit = normalize_max_local_computers(
            current["maxLocalComputersPerEmployee"]
            if max_local_computers_per_employee is None
            else max_local_computers_per_employee
        )
        rounds = normalize_max_task_rounds(
            current["maxTaskRounds"] if max_task_rounds is None else max_task_rounds
        )
        hosts = normalize_skill_import_hosts(
            current["skillImportAllowedHosts"] if skill_import_allowed_hosts is None else skill_import_allowed_hosts
        )
        now = datetime.now(timezone.utc)
        with store_transaction(self.engine) as conn:
            existing = conn.scalar(
                select(self.settings.c.id).where(self.settings.c.id == SETTINGS_ROW_ID)
            )
            if existing:
                values: dict[str, Any] = {"updated_at": now}
                if max_local_computers_per_employee is not None:
                    values["max_local_computers_per_employee"] = limit
                if max_task_rounds is not None:
                    values["max_task_rounds"] = rounds
                if skill_import_allowed_hosts is not None:
                    values["skill_import_allowed_hosts"] = hosts
                conn.execute(
                    update(self.settings)
                    .where(self.settings.c.id == SETTINGS_ROW_ID)
                    .values(**values)
                )
            else:
                conn.execute(
                    insert(self.settings).values(
                        id=SETTINGS_ROW_ID,
                        max_local_computers_per_employee=limit,
                        max_task_rounds=rounds,
                        skill_import_allowed_hosts=hosts,
                        created_at=now,
                        updated_at=now,
                    )
                )
        return self.get_settings()


def _row_to_settings(row: Any) -> dict[str, Any]:
    return {
        "maxLocalComputersPerEmployee": int(row["max_local_computers_per_employee"]),
        "maxTaskRounds": int(row["max_task_rounds"]),
        "skillImportAllowedHosts": list(row["skill_import_allowed_hosts"]),
        "updatedAt": _format_iso(row["updated_at"]),
    }
