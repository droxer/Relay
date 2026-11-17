"""Allow Workflow definitions owned by either a Team or a Project."""
from alembic import op
import sqlalchemy as sa

from relay.persistence.sql import entity_uuid_type

revision = '20261117_0130'
down_revision = '20261117_0129'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    columns = {column['name'] for column in sa.inspect(conn).get_columns('workflows')}
    if 'owner_team_id' in columns:
        return
    with op.batch_alter_table('workflows') as batch:
        batch.alter_column('project_id', existing_type=entity_uuid_type(), nullable=True)
        batch.add_column(sa.Column('owner_team_id', entity_uuid_type(), nullable=True))
        batch.create_foreign_key('fk_workflow_owner_team', 'teams', ['owner_team_id'], ['id'], ondelete='RESTRICT')
        batch.create_check_constraint('ck_workflow_owner_scope', '(project_id IS NOT NULL AND owner_team_id IS NULL) OR (project_id IS NULL AND owner_team_id IS NOT NULL)')


def downgrade() -> None:
    conn = op.get_bind()
    if conn.execute(sa.text('SELECT 1 FROM workflows WHERE owner_team_id IS NOT NULL LIMIT 1')).first():
        raise RuntimeError('Team-owned Workflows require a forward fix before downgrade.')
    with op.batch_alter_table('workflows') as batch:
        batch.drop_constraint('ck_workflow_owner_scope', type_='check')
        # Fresh schemas use the metadata-generated foreign key name.
        for foreign in sa.inspect(conn).get_foreign_keys('workflows'):
            if foreign['constrained_columns'] == ['owner_team_id'] and foreign['name']:
                batch.drop_constraint(foreign['name'], type_='foreignkey')
        batch.drop_column('owner_team_id')
        batch.alter_column('project_id', existing_type=entity_uuid_type(), nullable=False)
