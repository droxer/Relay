"""Exercise the Postgres adapter without requiring a running database."""

from contextlib import contextmanager
from types import SimpleNamespace
from uuid import UUID

import pytest
import conftest
import postgres_backend as pg
from sqlalchemy.dialects.postgresql import dialect
from sqlalchemy.dialects.postgresql.types import PGUuid

from relay.persistence import sql
from relay.persistence.account import waitlist
from relay.persistence.daemon import nodes
from relay.persistence.task import reads


@pytest.fixture(autouse=True)
def isolate_adapter_state(monkeypatch):
    # These unit tests also run inside the real adapter when the entire suite
    # uses Postgres. Preserve that outer test's schema and alias state.
    monkeypatch.setattr(pg, "_active", None)
    monkeypatch.setattr(pg, "_aliasing", False)
    monkeypatch.setattr(pg, "_aliases", {})


@contextmanager
def adapter_fixture(monkeypatch, tmp_path, *, marked=False):
    monkeypatch.setenv(pg.STORE_BACKEND_ENV, "postgres")
    monkeypatch.setenv(pg.ALIAS_TEXT_IDS_ENV, "1")
    monkeypatch.setattr(pg, "_acquire", lambda: ("fake_schema", "postgresql://fake"))
    monkeypatch.setattr(pg, "_release", lambda schema, url: None)
    fixture = conftest.postgres_store_backend.__wrapped__
    kwargs = dict(clear_storage_env=None, monkeypatch=monkeypatch, tmp_path=tmp_path)
    kwargs["request"] = SimpleNamespace(node=SimpleNamespace(
        get_closest_marker=lambda name: pytest.mark.postgres if marked else None))
    generator = fixture(**kwargs)
    next(generator)
    try:
        yield
    finally:
        generator.close()


@pytest.mark.parametrize("module", [sql, waitlist, nodes, reads])
def test_readable_ids_pass_guards_and_round_trip(monkeypatch, tmp_path, module):
    engine = SimpleNamespace(dialect=dialect())
    original_guard = module.names_no_uuid_row
    with adapter_fixture(monkeypatch, tmp_path):
        assert not module.names_no_uuid_row(engine, "sbx_alice")
        uuid_type = PGUuid(as_uuid=False)
        bind = uuid_type.bind_processor(engine.dialect)
        result = uuid_type.result_processor(engine.dialect, None)
        stored_id = bind("sbx_alice")
        assert str(UUID(stored_id)) == stored_id
        assert result(stored_id) == "sbx_alice"
    assert module.names_no_uuid_row is original_guard
    assert module.names_no_uuid_row(engine, "sbx_alice")
    # SQLAlchemy may cache a processor created while the patch was active.
    assert bind("sbx_alice") == "sbx_alice"
    assert result(stored_id) == stored_id


def test_postgres_marker_preserves_raw_uuid_binds(monkeypatch, tmp_path):
    with adapter_fixture(monkeypatch, tmp_path, marked=True):
        bind = PGUuid(as_uuid=False).bind_processor(dialect())
        assert (bind("not-a-uuid") if bind else "not-a-uuid") == "not-a-uuid"
        assert not pg._aliasing


def test_alias_opt_out_preserves_uuid_validation(monkeypatch):
    monkeypatch.setenv(pg.ALIAS_TEXT_IDS_ENV, "0")
    with pg.postgres_test_databases():
        assert sql.names_no_uuid_row(SimpleNamespace(dialect=dialect()), "sbx_alice")
        assert not pg._aliasing


def test_nested_raw_context_restores_outer_aliases(monkeypatch):
    monkeypatch.setenv(pg.ALIAS_TEXT_IDS_ENV, "1")
    with pg.postgres_test_databases():
        bind = PGUuid(as_uuid=False).bind_processor(dialect())
        result = PGUuid(as_uuid=False).result_processor(dialect(), None)
        stored_id = bind("outer_node")
        with pg.postgres_test_databases(alias_text_ids=False):
            assert bind("raw_node") == "raw_node"
            assert result(stored_id) == stored_id
        assert result(stored_id) == "outer_node"
        assert bind("outer_node") == stored_id
