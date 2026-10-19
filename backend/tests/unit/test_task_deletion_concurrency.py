from concurrent.futures import ThreadPoolExecutor
import os
from threading import Barrier, BrokenBarrierError
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from relay.persistence.session.store import DatabaseSessionStore
from relay.persistence.events import relay_event
from relay.persistence.task.store import DatabaseTaskStore
from relay.tasks.deletion import delete_task


@pytest.mark.postgres
def test_concurrent_task_deletes_remove_the_shared_thread(monkeypatch) -> None:
    url = os.environ.get("RELAY_TEST_DATABASE_URL")
    if not url:
        pytest.skip("requires RELAY_TEST_DATABASE_URL")
    schema = "task_delete_" + uuid4().hex
    admin = create_engine(url)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped_url = make_url(url).update_query_dict({"options": f"-c search_path={schema}"})
    sessions = None
    try:
        sessions = DatabaseSessionStore(scoped_url.render_as_string(hide_password=False), create_schema=True)
        tasks = DatabaseTaskStore(scoped_url.render_as_string(hide_password=False))
        session = sessions.create_session({
            "workspacePath": "/workspace", "taskGoal": "Shared round", "participants": ["human"],
        })
        sessions.append_event(session["id"], relay_event(
            "session.completed", session["id"], {"outcome": "Done"}))
        records = [tasks.create_task({"title": title}) for title in ("First", "Second")]
        for task in records:
            tasks.link_session(task["id"], session["id"])

        # Without cross-replica coordination, both tombstones are uncommitted
        # when each transaction checks whether the other task still needs the thread.
        barrier = Barrier(2)
        original = tasks.delete_task

        def tombstone(*args, **kwargs):
            result = original(*args, **kwargs)
            try:
                barrier.wait(timeout=1)
            except BrokenBarrierError:
                # A serialized first delete must proceed while the second waits
                # for the transaction lock, rather than waiting indefinitely.
                pass
            return result

        monkeypatch.setattr(tasks, "delete_task", tombstone)
        ctx = SimpleNamespace(task_store=tasks, session_store=sessions, chat_store=Mock())
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(
                lambda task: delete_task(ctx, task["id"], {"isAdmin": True}), records))
        assert all(result["outcome"] == "deleted" for result in results)
        assert tasks.list_tasks_for_session(session["id"]) == []
        with pytest.raises(KeyError):
            sessions.get_session(session["id"])
    finally:
        if sessions is not None:
            sessions.engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
