"""Hot reads minimize database work without changing record visibility."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import event, update
from store_fixtures import make_agent_store, make_auth_store, make_session_store, make_task_store


def _traffic(engine):
    queries, checkouts = [], []
    event.listen(engine, "before_cursor_execute", lambda conn, cursor, sql, *args: (
        queries.append(sql) if sql.lstrip().upper().startswith("SELECT") else None
    ))
    event.listen(engine, "checkout", lambda *args: checkouts.append(1))
    return queries, checkouts


@pytest.mark.parametrize("state", ["active", "deleted", "detached", "missing"])
def test_account_lookup_joins_the_user_in_one_query(tmp_path, state):
    store = make_auth_store(tmp_path)
    created = store.create_account("alice", "kestrel-vault-7719", display_name="Alice")
    if state == "deleted":
        with store.engine.begin() as conn:
            conn.execute(update(store.users).where(store.users.c.id == created["userId"]).values(
                deleted_at=datetime.now(UTC)
            ))
    elif state == "detached":
        with store.engine.begin() as conn:
            conn.execute(update(store.accounts).where(store.accounts.c.id == created["id"]).values(user_id=None))
    queries, checkouts = _traffic(store.engine)
    account = store.get_account_by_id(str(uuid4()) if state == "missing" else created["id"])
    assert (account is None) is (state in {"deleted", "missing"})
    if account:
        assert account.get("displayName") == ("Alice" if state == "active" else None)
        assert account["id"] == created["id"]
    assert len(queries) == 1
    assert len(checkouts) == 1


def test_agent_batch_preserves_order_and_omits_deleted_and_missing(tmp_path):
    owner = make_auth_store(tmp_path).create_account("alice", "kestrel-vault-7719")["userId"]
    store = make_agent_store(tmp_path)
    agents = [store.create_agent(owner, {
        "displayName": f"Agent {i}", "executorKind": "claude", "defaultRole": "implementer",
    }) for i in range(4)]
    store.delete_agent(agents[2]["id"])
    queries, checkouts = _traffic(store.engine)
    found = store.get_agents_by_ids([
        agents[3]["id"], agents[0]["id"], agents[3]["id"], agents[2]["id"], str(uuid4()),
    ])
    assert found == [agents[3], agents[0]]
    assert len(queries) == 1
    assert len(checkouts) == 1
    queries.clear()
    checkouts.clear()
    assert store.get_agents_by_ids([]) == []
    assert not queries and not checkouts


def test_large_agent_batch_bounds_parameters_and_reuses_the_connection(tmp_path):
    store = make_agent_store(tmp_path)
    queries, checkouts = _traffic(store.engine)
    assert store.get_agents_by_ids([str(uuid4()) for _ in range(501)]) == []
    assert len(queries) == 2
    assert len(checkouts) == 1


@pytest.mark.parametrize("factory", [make_session_store, make_task_store])
def test_schema_verification_reuses_one_checkout(tmp_path, factory):
    store = factory(tmp_path)
    _, checkouts = _traffic(store.engine)
    store.verify_schema()
    assert len(checkouts) == 1
