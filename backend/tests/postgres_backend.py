"""Run the database-backed tests on Postgres instead of SQLite.

Tests build their stores on SQLite, which accepts SQL that Postgres -- the
production database -- rejects (a string literal in ``GROUP BY``, a non-UUID
bound to a ``uuid`` column). Set ``RELAY_TEST_STORE_BACKEND=postgres`` together
with ``RELAY_TEST_DATABASE_URL`` and every database a test reaches through
``store_fixtures.sqlite_url`` or the app's ``RELAY_DATABASE_URL`` becomes a
scratch schema on that Postgres, built from the declared metadata and stamped
at the Alembic head. Each distinct SQLite URL maps to its own schema, so tests
that deliberately keep two databases apart still do.

    RELAY_TEST_STORE_BACKEND=postgres \\
    RELAY_TEST_DATABASE_URL=postgresql+psycopg://$USER@localhost:5432/relay_test \\
    uv run pytest tests/unit/test_session_store.py

Tests name records with readable ids (``"sbx_alice"``), which a native
``uuid`` column refuses. While a test runs on the stand-in, each such id is
bound as a stable uuid5 alias and read back as the original string, so the run
surfaces dialect differences rather than fixture naming. Set
``RELAY_TEST_PG_ALIAS_TEXT_IDS=0`` to see the raw refusals instead -- that is
how non-UUID ids reaching a uuid lookup (a 500 where SQLite answers "not
found") are found; ``@pytest.mark.postgres`` tests never alias.

Schemas are emptied (``TRUNCATE``) after each test and reused, because
building ~60 tables per test would dominate the run; they are dropped when
the test process exits. Tests that build a hard-coded ``sqlite:///`` URL
themselves stay on SQLite. ``disposable_postgres_url`` gives a
``@pytest.mark.postgres`` regression test the same scratch schema directly.
"""

from __future__ import annotations

import atexit
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text
from sqlalchemy.dialects.postgresql.types import PGUuid
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool

from relay.persistence import engine as engine_module
from relay.persistence import sql
from relay.persistence.account import waitlist
from relay.persistence.daemon import nodes
from relay.persistence.task import reads

STORE_BACKEND_ENV = "RELAY_TEST_STORE_BACKEND"
TEST_DATABASE_URL_ENV = "RELAY_TEST_DATABASE_URL"
ALIAS_TEXT_IDS_ENV = "RELAY_TEST_PG_ALIAS_TEXT_IDS"
SCHEMA_PREFIX = "relay_test_"
ALEMBIC_VERSION_TABLE = "alembic_version"

# sqlite URL -> (schema, scoped Postgres URL) for the running test; None when off.
_active: dict[str, tuple[str, str]] | None = None
# Emptied schemas ready for the next test.
_free: list[tuple[str, str]] = []
_created: list[str] = []
_head_revision: str | None = None
_admin_engine: Any = None
# Alias uuid -> the readable id it stands for, while aliasing is on.
_aliases: dict[str, str] = {}
_aliasing = False


def postgres_backend_requested() -> bool:
    return os.environ.get(STORE_BACKEND_ENV, "").strip().lower() == "postgres"


def _alias_text_ids_requested() -> bool:
    return os.environ.get(ALIAS_TEXT_IDS_ENV, "1").strip().lower() not in {"0", "false", "no", "off"}


def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
    except ValueError:
        return False
    return True


def _alias_text_id(value: Any) -> Any:
    if _aliasing and isinstance(value, str) and not _is_uuid(value):
        alias = str(uuid5(NAMESPACE_URL, "relay-test-id:" + value))
        _aliases[alias] = value
        return alias
    return value


def _install_text_id_aliases(monkeypatch: pytest.MonkeyPatch) -> None:
    """Wrap Postgres uuid binds/results so readable test ids round-trip."""
    bind_processor = PGUuid.bind_processor
    result_processor = PGUuid.result_processor

    def aliased_bind_processor(self: Any, dialect: Any) -> Any:
        inner = bind_processor(self, dialect)

        def process(value: Any) -> Any:
            value = _alias_text_id(value)
            return inner(value) if inner else value

        return process

    def aliased_result_processor(self: Any, dialect: Any, coltype: Any) -> Any:
        inner = result_processor(self, dialect, coltype)

        def process(value: Any) -> Any:
            value = inner(value) if inner else value
            if _aliasing and value is not None:
                return _aliases.get(str(value), value)
            return value

        return process

    monkeypatch.setattr(PGUuid, "bind_processor", aliased_bind_processor)
    monkeypatch.setattr(PGUuid, "result_processor", aliased_result_processor)

    # These guards run before SQLAlchemy binds the id. Give them the same
    # alias as the binder, including each store's directly imported reference.
    original_guard = sql.names_no_uuid_row

    def aliased_guard(engine: Any, value: Any) -> bool:
        if engine.dialect.name == "postgresql":
            value = _alias_text_id(value)
        return original_guard(engine, value)

    for module in (sql, waitlist, nodes, reads):
        monkeypatch.setattr(module, "names_no_uuid_row", aliased_guard)


def _base_url() -> str:
    url = os.environ.get(TEST_DATABASE_URL_ENV, "").strip()
    if not url:
        raise RuntimeError(f"{STORE_BACKEND_ENV}=postgres requires {TEST_DATABASE_URL_ENV}.")
    return url


def _admin() -> Any:
    global _admin_engine
    if _admin_engine is None:
        _admin_engine = create_engine(_base_url(), poolclass=NullPool)
    return _admin_engine


def _alembic_head() -> str:
    global _head_revision
    if _head_revision is None:
        backend_root = Path(__file__).resolve().parents[1]
        config = Config(str(backend_root / "alembic.ini"))
        config.set_main_option("script_location", str(backend_root / "migrations"))
        head = ScriptDirectory.from_config(config).get_current_head()
        if head is None:
            raise RuntimeError("Alembic has no single head revision.")
        _head_revision = head
    return _head_revision


def _scoped_url(schema: str) -> str:
    scoped = make_url(_base_url()).update_query_dict({"options": f"-c search_path={schema}"})
    return scoped.render_as_string(hide_password=False)


def _create_schema() -> tuple[str, str]:
    schema = SCHEMA_PREFIX + uuid4().hex
    with _admin().begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    _created.append(schema)
    url = _scoped_url(schema)
    # The app creates tables itself only on SQLite (production migrates with
    # Alembic), and the session store refuses a Postgres database without an
    # Alembic revision, so build the tables and stamp the head here.
    engine = create_engine(url, poolclass=NullPool)
    try:
        engine_module.create_all_tables(engine)
        with engine.begin() as conn:
            conn.execute(text(
                f"CREATE TABLE {ALEMBIC_VERSION_TABLE} (version_num VARCHAR(32) PRIMARY KEY)"))
            conn.execute(text(f"INSERT INTO {ALEMBIC_VERSION_TABLE} VALUES (:head)"),
                         {"head": _alembic_head()})
    finally:
        engine.dispose()
    return schema, url


def _empty_schema(schema: str) -> None:
    with _admin().begin() as conn:
        tables = conn.scalars(
            text("SELECT tablename FROM pg_tables WHERE schemaname = :schema AND tablename <> :keep"),
            {"schema": schema, "keep": ALEMBIC_VERSION_TABLE},
        ).all()
        if tables:
            names = ", ".join(f'"{schema}"."{table}"' for table in tables)
            conn.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))


def _drop_all_schemas() -> None:
    if _admin_engine is None:
        return
    with _admin_engine.begin() as conn:
        for schema in _created:
            conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
    _admin_engine.dispose()


atexit.register(_drop_all_schemas)


def _acquire() -> tuple[str, str]:
    return _free.pop() if _free else _create_schema()


def _release(schema: str, url: str) -> None:
    with engine_module._ENGINE_LOCK:
        engine = engine_module._ENGINES.pop(url, None)
    if engine is not None:
        engine.dispose()
    _empty_schema(schema)
    _free.append((schema, url))


def database_url_for(sqlite_url: str) -> str:
    """The URL a test should use for ``sqlite_url`` under the active backend."""
    if _active is None:
        return sqlite_url
    entry = _active.get(sqlite_url)
    if entry is None:
        entry = _acquire()
        _active[sqlite_url] = entry
    return entry[1]


@contextmanager
def postgres_test_databases(*, alias_text_ids: bool = True) -> Iterator[None]:
    """Map SQLite URLs to empty Postgres schemas for one test."""
    global _active, _aliasing, _aliases
    previous = _active, _aliasing, _aliases
    _active = {}
    _aliases = {}
    _aliasing = alias_text_ids and _alias_text_ids_requested()
    try:
        with pytest.MonkeyPatch.context() as monkeypatch:
            if _aliasing:
                _install_text_id_aliases(monkeypatch)
            yield
    finally:
        entries = list(_active.values())
        _active, _aliasing, _aliases = previous
        for schema, url in entries:
            _release(schema, url)


@contextmanager
def disposable_postgres_url() -> Iterator[str]:
    """An empty, migrated-shape Postgres schema for one ``@pytest.mark.postgres``
    test; skips the test when ``RELAY_TEST_DATABASE_URL`` is unset."""
    if not os.environ.get(TEST_DATABASE_URL_ENV, "").strip():
        pytest.skip(f"requires {TEST_DATABASE_URL_ENV}")
    schema, url = _acquire()
    try:
        yield url
    finally:
        _release(schema, url)
