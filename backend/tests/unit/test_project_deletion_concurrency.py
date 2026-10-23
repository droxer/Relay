"""Project deletion must coexist with linking a retained outside thread."""
from concurrent.futures import ThreadPoolExecutor
import os
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from relay.persistence.engine import store_transaction
from relay.persistence.project.store import DatabaseProjectStore
from relay.persistence.session.store import DatabaseSessionStore
from relay.persistence.task.store import DatabaseTaskStore
from relay.projects.deletion import _scope
from relay.security.auth import DatabaseAccountAuthStore


@pytest.mark.postgres
def test_project_scope_does_not_deadlock_with_linking_an_outside_thread(monkeypatch):
    url = os.environ.get("RELAY_TEST_DATABASE_URL")
    if not url:
        pytest.skip("requires RELAY_TEST_DATABASE_URL")
    schema = "project_delete_" + uuid4().hex
    admin = create_engine(url)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped_url = make_url(url).update_query_dict({"options": f"-c search_path={schema}"})
    sessions = None
    try:
        database_url = scoped_url.render_as_string(hide_password=False)
        sessions = DatabaseSessionStore(database_url, create_schema=True)
        tasks = DatabaseTaskStore(database_url)
        projects = DatabaseProjectStore(database_url)
        owner = DatabaseAccountAuthStore(database_url).ensure_user("alice")
        project = projects.create_project(owner["id"], {
            "name": "Remove", "computerId": "computer", "members": [],
        })
        task = tasks.create_task({"title": "Work", "projectId": project["id"]})
        session = sessions.create_session({"workspacePath": "/workspace", "taskGoal": "Outside"})
        tasks.link_session(task["id"], session["id"])
        ctx = SimpleNamespace(task_store=tasks, session_store=sessions)
        held, proceed = Event(), Event()
        original = tasks._lock_session_for_link

        def hold_link(conn, session_id):
            original(conn, session_id)
            held.set()
            assert proceed.wait(timeout=5)

        monkeypatch.setattr(tasks, "_lock_session_for_link", hold_link)
        with ThreadPoolExecutor(max_workers=1) as pool:
            linking = pool.submit(tasks.link_session, task["id"], session["id"])
            try:
                assert held.wait(timeout=5)
                with store_transaction(tasks.engine) as conn:
                    conn.execute(text("SET LOCAL lock_timeout = '1s'"))
                    # Linking holds KEY SHARE on the thread, then waits for
                    # this task. The scope must not wait for that thread lock.
                    scope = _scope(conn, ctx, project["id"], lock=True)
                    assert [thread["id"] for thread in scope.linked] == [session["id"]]
            finally:
                proceed.set()
            assert linking.result(timeout=5)["id"] == task["id"]
    finally:
        if sessions is not None:
            sessions.engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
