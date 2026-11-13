from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine, text
from postgres_backend import database_url_for, postgres_backend_requested, postgres_test_databases
from relay.security import admin_token as admin_token_module
from relay.security import credentials
from store_fixtures import isolated_store_engines


@pytest.fixture(scope="session", autouse=True)
def postgres_extensions():
    """Keep database-wide extensions outside workers' disposable schemas."""
    url = os.environ.get("RELAY_TEST_DATABASE_URL")
    if not url:
        return
    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            # IF NOT EXISTS alone races between xdist workers. Commit setup
            # before releasing the lock or allowing any schema migration.
            connection.execute(text("SELECT pg_advisory_xact_lock(hashtext('relay.tests.extensions'))"))
            connection.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public"))
    finally:
        engine.dispose()


def pytest_addoption(parser):
    parser.addoption(
        "--full-password-cost", action="store_true", default=False,
        help="Use the production password hashing cost in every test.",
    )


@pytest.fixture(autouse=True)
def password_hash_cost(monkeypatch, request):
    # Keep real PBKDF2, random salts, encoded rounds, and constant-time checks.
    # Repeating the production work factor tests CPU speed rather than auth
    # behavior; dedicated credential tests still exercise the production cost.
    if not (
        request.config.getoption("--full-password-cost")
        or request.node.get_closest_marker("production_password_hash")
    ):
        monkeypatch.setattr(credentials, "PW_HASH_ITERATIONS", 1_000)


@pytest.fixture(autouse=True)
def release_store_engines():
    # Run teardown after fixtures that create stores, including Postgres's
    # own cleanup, by making this a dependency of the environment fixture.
    with isolated_store_engines():
        yield


@pytest.fixture(autouse=True)
def clear_storage_env(monkeypatch, tmp_path, release_store_engines) -> None:
    # create_app wires a module-level admin token store; never let one test's
    # database answer for the next.
    monkeypatch.setattr(admin_token_module, "_admin_token_store", None)
    monkeypatch.delenv("RELAY_STORAGE", raising=False)
    monkeypatch.delenv("RELAY_AUTH_STORE", raising=False)
    monkeypatch.delenv("RELAY_DAEMON_STORE", raising=False)
    monkeypatch.delenv("RELAY_CHAT_STORE", raising=False)
    monkeypatch.delenv("RELAY_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("RELAY_DATABASE_URL", f"sqlite:///{tmp_path}/relay-sessions.db")


@pytest.fixture(autouse=True)
def postgres_store_backend(clear_storage_env, monkeypatch, tmp_path, request):
    """Rebuild the test's databases on Postgres when RELAY_TEST_STORE_BACKEND=postgres."""
    if not postgres_backend_requested():
        yield
        return
    with postgres_test_databases(alias_text_ids=request.node.get_closest_marker("postgres") is None):
        monkeypatch.setenv(
            "RELAY_DATABASE_URL", database_url_for(f"sqlite:///{tmp_path}/relay-sessions.db"))
        yield


@pytest.fixture
def database_io_off_event_loop():
    """Assert real SQL stays off asyncio loops throughout an HTTP scenario."""
    import asyncio

    from sqlalchemy import event
    from sqlalchemy.engine import Engine

    def check(*args):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return
        raise AssertionError("Synchronous SQL executed on the application event loop")

    event.listen(Engine, "before_cursor_execute", check)
    try:
        yield
    finally:
        event.remove(Engine, "before_cursor_execute", check)
