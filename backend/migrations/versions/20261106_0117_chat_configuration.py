"""Isolate integration configuration and encrypted credentials by record.

Revision ID: 20261106_0117
Revises: 20261106_0116

Upgrade never decrypts credentials. The runtime atomically converts the legacy
map with its configured Fernet key on first credential-aware access. Downgrade
requires that same key if per-integration envelopes have been written.
"""

import json
import os

from alembic import op
from cryptography.fernet import Fernet, InvalidToken
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261106_0117"
down_revision = "20261106_0116"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("chat_integrations",
        sa.Column("sequence", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("integration_id", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=True),
        sa.Column("tenant_id", sa.Text(), nullable=True),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.UniqueConstraint("integration_id", name="uq_chat_integrations_id"),
    )
    op.create_table("chat_integration_secrets",
        sa.Column("integration_id", sa.Text(), primary_key=True),
        sa.Column("ciphertext", sa.Text(), nullable=False),
        sa.Column("secret_keys", postgresql.JSONB(), nullable=False),
    )
    op.execute("""
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM chat_documents WHERE document_key = 'integrations'
          AND jsonb_typeof(payload) IS DISTINCT FROM 'array') THEN
          RAISE EXCEPTION 'Legacy chat integrations must be an array';
        END IF;
        IF EXISTS (SELECT 1 FROM chat_documents d, LATERAL jsonb_array_elements(d.payload) e(value)
          WHERE d.document_key = 'integrations' AND (
            jsonb_typeof(e.value) IS DISTINCT FROM 'object'
            OR jsonb_typeof(e.value->'id') IS DISTINCT FROM 'string'
            OR coalesce(e.value->>'id', '') = '')) THEN
          RAISE EXCEPTION 'Legacy chat integrations must have nonempty string IDs';
        END IF;
        IF EXISTS (SELECT e.value->>'id' FROM chat_documents d, LATERAL jsonb_array_elements(d.payload) e(value)
          WHERE d.document_key = 'integrations' GROUP BY e.value->>'id' HAVING count(*) > 1) THEN
          RAISE EXCEPTION 'Legacy chat integrations contain duplicate IDs';
        END IF;
      END $$;
    """)
    op.execute("""
      INSERT INTO chat_integrations (sequence, integration_id, provider, status, tenant_id, payload)
      SELECT e.sequence, e.payload->>'id',
        CASE WHEN jsonb_typeof(e.payload->'provider') = 'string' THEN e.payload->>'provider' END,
        CASE WHEN jsonb_typeof(e.payload->'status') = 'string' THEN e.payload->>'status' END,
        CASE WHEN jsonb_typeof(e.payload->'tenantId') = 'string' THEN e.payload->>'tenantId' END,
        e.payload
      FROM chat_documents d, LATERAL jsonb_array_elements(d.payload) WITH ORDINALITY e(payload, sequence)
      WHERE d.document_key = 'integrations'
    """)
    op.execute("""
      SELECT setval(pg_get_serial_sequence('chat_integrations', 'sequence'),
        coalesce(max(sequence), 1), count(*) > 0) FROM chat_integrations
    """)
    op.create_index("ix_chat_integrations_routing", "chat_integrations", ["provider", "status", "tenant_id", "sequence"])
    op.execute("DELETE FROM chat_documents WHERE document_key = 'integrations'")


def _restore_secret_map(conn) -> None:
    rows = conn.execute(sa.text("SELECT integration_id, ciphertext FROM chat_integration_secrets")).all()
    if not rows:
        return
    if conn.scalar(sa.text("SELECT id FROM chat_documents WHERE document_key = 'secrets'")) is not None:
        raise RuntimeError("Legacy and normalized chat secrets coexist; reconcile before downgrade.")
    key = os.environ.get("RELAY_CHAT_SECRET_KEY", "").strip()
    if not key:
        raise RuntimeError("RELAY_CHAT_SECRET_KEY is required to downgrade normalized chat credentials.")
    try:
        cipher = Fernet(key.encode())
        values = {integration_id: json.loads(cipher.decrypt(ciphertext.encode())) for integration_id, ciphertext in rows}
    except (InvalidToken, ValueError) as error:
        raise RuntimeError("RELAY_CHAT_SECRET_KEY cannot decrypt normalized chat credentials for downgrade.") from error
    if any(not isinstance(value, dict) for value in values.values()):
        raise RuntimeError("Normalized chat credentials have an invalid encrypted format.")
    envelope = cipher.encrypt(json.dumps(values, separators=(",", ":")).encode()).decode()
    # Only ciphertext is ever bound into a database statement.
    conn.execute(sa.text("""
      INSERT INTO chat_documents (id, document_key, payload, updated_at)
      VALUES (gen_random_uuid(), 'secrets', jsonb_build_object('ciphertext', CAST(:ciphertext AS text)), CURRENT_TIMESTAMP)
    """), {"ciphertext": envelope})


def downgrade() -> None:
    conn = op.get_bind()
    if conn.scalar(sa.text("SELECT id FROM chat_documents WHERE document_key = 'integrations'")) is not None:
        raise RuntimeError("Legacy integration data remains; reconcile before downgrade.")
    _restore_secret_map(conn)
    op.execute("""
      INSERT INTO chat_documents (id, document_key, payload, updated_at)
      SELECT gen_random_uuid(), 'integrations',
        coalesce(jsonb_agg(payload ORDER BY sequence), '[]'::jsonb), CURRENT_TIMESTAMP FROM chat_integrations
    """)
    op.drop_table("chat_integration_secrets")
    op.drop_table("chat_integrations")
