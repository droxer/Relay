from __future__ import annotations

from typing import Any

from sqlalchemy import (
    inspect,
    select,
)

from ..engine import create_all_tables, shared_engine
from ..sql import metadata as shared_metadata
from ..tables import tasks as tasks_tables
from .writes import TaskWriteRows
from .dispatch import TaskDispatchRows
from .routines import TaskRoutineRows
from .links import TaskLinkRows
from .prerequisites import TaskPrerequisiteRows
from .reads import TaskReadRows



class DatabaseTaskStore(
    TaskWriteRows,
    TaskDispatchRows,
    TaskRoutineRows,
    TaskLinkRows,
    TaskPrerequisiteRows,
    TaskReadRows,
):

    metadata = shared_metadata

    tasks = tasks_tables.tasks
    events = tasks_tables.events
    number_counters = tasks_tables.number_counters
    task_sessions = tasks_tables.task_sessions
    task_prerequisites = tasks_tables.task_prerequisites

    def __init__(self, database_url: str, *, create_schema: bool = False):
        self.engine = shared_engine(database_url)
        # Only a running matcher drains the automation outbox; without one,
        # writing rows would grow the table forever. ``create_app`` turns this
        # off when the scheduler is disabled.
        self.emit_automation_events = True
        if create_schema:
            create_all_tables(self.engine)

    def verify_schema(self) -> None:
        schema = inspect(self.engine)
        required_tables = {
            "tasks",
            "task_events",
            "task_sessions",
            "task_number_counters",
            "task_prerequisites",
        }
        missing = required_tables.difference(schema.get_table_names())
        if missing:
            raise RuntimeError(
                f"Database is missing required task tables: {', '.join(sorted(missing))}."
            )
        required_columns = {
            table.name: set(table.c.keys())
            for table in (
                self.tasks,
                self.events,
                self.task_sessions,
                self.number_counters,
                self.task_prerequisites,
            )
        }
        for table_name, expected in required_columns.items():
            actual = {column["name"] for column in schema.get_columns(table_name)}
            absent = expected.difference(actual)
            if absent:
                raise RuntimeError(
                    f"Database table {table_name} is missing required columns: "
                    f"{', '.join(sorted(absent))}."
                )
        required_unique_constraints = {
            "task_events": {("task_id", "sequence")},
            "task_sessions": {("task_id", "session_id")},
        }
        for table_name, expected_unique in required_unique_constraints.items():
            actual_unique = {
                tuple(constraint.get("column_names") or ())
                for constraint in schema.get_unique_constraints(table_name)
            }
            absent_unique = expected_unique.difference(actual_unique)
            if absent_unique:
                rendered = ", ".join(
                    "(" + ", ".join(item) + ")" for item in sorted(absent_unique)
                )
                raise RuntimeError(
                    f"Database table {table_name} is missing required unique "
                    f"constraints: {rendered}."
                )










































    def _task_pk(self, conn: Any, task_id: str, *, lock: bool = False) -> str:
        statement = select(self.tasks.c.id).where(self.tasks.c.id == task_id)
        if lock:
            statement = statement.with_for_update()
        task_pk = conn.scalar(statement)
        if not task_pk:
            raise KeyError(task_id)
        return task_pk
