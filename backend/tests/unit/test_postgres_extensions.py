"""Database-wide extensions outlive each parallel worker's scratch schema."""

import os
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text

pytestmark = pytest.mark.postgres


def test_pgcrypto_survives_scratch_schema_cleanup():
    url = os.environ.get("RELAY_TEST_DATABASE_URL")
    if not url:
        pytest.skip("set RELAY_TEST_DATABASE_URL for PostgreSQL extension tests")
    engine = create_engine(url)
    schema = "extension_test_" + uuid4().hex
    try:
        with engine.begin() as conn:
            namespace = conn.scalar(text("""
                SELECT n.nspname FROM pg_extension e
                JOIN pg_namespace n ON n.oid = e.extnamespace
                WHERE e.extname = 'pgcrypto'
            """))
            assert namespace == "public"
            conn.execute(text(f'CREATE SCHEMA "{schema}"'))
            conn.execute(text(f'SET LOCAL search_path TO "{schema}"'))
            # Replay the initial migration under a worker's isolated search path.
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS pgcrypto"))
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
            assert conn.scalar(text("SELECT count(*) FROM pg_extension WHERE extname = 'pgcrypto'")) == 1
    finally:
        engine.dispose()
