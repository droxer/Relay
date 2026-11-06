"""Index growing chat records instead of rewriting shared JSON arrays.

Revision ID: 20261106_0116
Revises: 20261106_0115

Stop old backend replicas before upgrading or downgrading. The backfill stays
inside PostgreSQL: payloads and array order are preserved, and malformed legacy
records abort the entire transaction without consuming their source documents.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261106_0116"
down_revision = "20261106_0115"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "chat_audit_events",
        sa.Column("sequence", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("integration_id", sa.Text(), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
    )
    op.create_table(
        "chat_conversations",
        sa.Column("sequence", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("conversation_key", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.UniqueConstraint("conversation_key", name="uq_chat_conversations_key"),
    )
    op.execute("""
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM chat_documents
            WHERE document_key IN ('audit', 'conversations')
              AND jsonb_typeof(payload) IS DISTINCT FROM 'array'
          ) THEN
            RAISE EXCEPTION 'Legacy chat audit and conversations must be arrays';
          END IF;
          IF EXISTS (
            SELECT 1 FROM chat_documents d,
              LATERAL jsonb_array_elements(d.payload) e(value)
            WHERE d.document_key IN ('audit', 'conversations')
              AND jsonb_typeof(e.value) IS DISTINCT FROM 'object'
          ) THEN
            RAISE EXCEPTION 'Legacy chat arrays must contain objects';
          END IF;
          IF EXISTS (
            SELECT 1 FROM chat_documents d,
              LATERAL jsonb_array_elements(d.payload) e(value)
            WHERE d.document_key = 'audit'
              AND jsonb_typeof(e.value->'integrationId') NOT IN ('string', 'null')
          ) THEN
            RAISE EXCEPTION 'Legacy chat audit integrationId must be a string or null';
          END IF;
          IF EXISTS (
            SELECT 1 FROM chat_documents d,
              LATERAL jsonb_array_elements(d.payload) e(value)
            WHERE d.document_key = 'conversations' AND (
              jsonb_typeof(e.value->'key') IS DISTINCT FROM 'string'
              OR coalesce(e.value->>'key', '') = ''
              OR jsonb_typeof(e.value->'sessionId') IS DISTINCT FROM 'string'
              OR coalesce(e.value->>'sessionId', '') = ''
            )
          ) THEN
            RAISE EXCEPTION 'Legacy chat conversations need nonempty key and sessionId strings';
          END IF;
          IF EXISTS (
            SELECT e.value->>'key' FROM chat_documents d,
              LATERAL jsonb_array_elements(d.payload) e(value)
            WHERE d.document_key = 'conversations'
            GROUP BY e.value->>'key' HAVING count(*) > 1
          ) THEN
            RAISE EXCEPTION 'Legacy chat conversations contain duplicate keys';
          END IF;
        END $$;
    """)
    op.execute("""
        INSERT INTO chat_audit_events (sequence, integration_id, payload)
        SELECT e.sequence, e.payload->>'integrationId', e.payload
        FROM chat_documents d,
          LATERAL jsonb_array_elements(d.payload) WITH ORDINALITY e(payload, sequence)
        WHERE d.document_key = 'audit'
    """)
    op.execute("""
        INSERT INTO chat_conversations (sequence, conversation_key, session_id, payload)
        SELECT e.sequence, e.payload->>'key', e.payload->>'sessionId', e.payload
        FROM chat_documents d,
          LATERAL jsonb_array_elements(d.payload) WITH ORDINALITY e(payload, sequence)
        WHERE d.document_key = 'conversations'
    """)
    for table in ("chat_audit_events", "chat_conversations"):
        op.execute(sa.text(f"""
            SELECT setval(pg_get_serial_sequence('{table}', 'sequence'),
                coalesce(max(sequence), 1), count(*) > 0) FROM {table}
        """))
    op.create_index("ix_chat_audit_events_integration_sequence", "chat_audit_events", ["integration_id", "sequence"])
    op.create_index("ix_chat_conversations_session", "chat_conversations", ["session_id"])
    op.execute("DELETE FROM chat_documents WHERE document_key IN ('audit', 'conversations')")


def downgrade() -> None:
    for key, table in (("audit", "chat_audit_events"), ("conversations", "chat_conversations")):
        op.execute(sa.text(f"""
            INSERT INTO chat_documents (id, document_key, payload, updated_at)
            SELECT gen_random_uuid(), '{key}',
              coalesce(jsonb_agg(payload ORDER BY sequence), '[]'::jsonb), CURRENT_TIMESTAMP
            FROM {table}
            ON CONFLICT (document_key) DO UPDATE
              SET payload = excluded.payload, updated_at = excluded.updated_at
        """))
    op.drop_table("chat_conversations")
    op.drop_table("chat_audit_events")
