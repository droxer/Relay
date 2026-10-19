from __future__ import annotations

from threading import RLock

from ..engine import create_all_tables, shared_engine
from ..sql import metadata as shared_metadata
from ..tables import auth as auth_tables
from ..tables import skills as skills_tables
from .assignments import SkillAssignmentRows
from .events import SkillEventRows
from .objects import SkillObjectStore
from .reads import SkillReadRows
from .writes import SkillWriteRows


class DatabaseSkillStore(
    SkillWriteRows,
    SkillAssignmentRows,
    SkillReadRows,
    SkillEventRows,
):
    """Event-authoritative catalog with immutable bundle revisions."""

    metadata = shared_metadata
    users = auth_tables.users
    skills = skills_tables.skills
    revisions = skills_tables.revisions
    blobs = skills_tables.blobs
    files = skills_tables.files
    events_table = skills_tables.events_table
    assignments = skills_tables.assignments

    def __init__(
        self,
        database_url: str,
        *,
        object_store: SkillObjectStore,
        create_schema: bool = False,
    ):
        self.engine = shared_engine(database_url)
        self.object_store = object_store
        self._write_lock = RLock()
        if create_schema:
            create_all_tables(self.engine)
