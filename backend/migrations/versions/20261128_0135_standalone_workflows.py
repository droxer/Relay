"""Allow user-owned, Computer-bound standalone Workflow definitions."""
from alembic import op
import sqlalchemy as sa

revision = '20261128_0135'
down_revision = '20261125_0134'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    if 'computer_id' in {column['name'] for column in sa.inspect(conn).get_columns('workflows')}:
        return
    with op.batch_alter_table('workflows') as batch:
        batch.add_column(sa.Column('computer_id', sa.Text(), nullable=True))
        batch.drop_constraint('ck_workflow_owner_scope', type_='check')
        batch.create_check_constraint('ck_workflow_owner_scope',
            '(project_id IS NOT NULL AND owner_team_id IS NULL AND computer_id IS NULL) OR '
            '(project_id IS NULL AND owner_team_id IS NOT NULL AND computer_id IS NULL) OR '
            '(project_id IS NULL AND owner_team_id IS NULL AND computer_id IS NOT NULL)')
        batch.create_index('ix_workflows_owner_computer', ['owner_user_id', 'computer_id'])


def downgrade() -> None:
    conn = op.get_bind()
    if conn.execute(sa.text('SELECT 1 FROM workflows WHERE computer_id IS NOT NULL LIMIT 1')).first():
        raise RuntimeError('Standalone Workflows require a forward fix before downgrade.')
    with op.batch_alter_table('workflows') as batch:
        batch.drop_index('ix_workflows_owner_computer')
        batch.drop_constraint('ck_workflow_owner_scope', type_='check')
        batch.drop_column('computer_id')
        batch.create_check_constraint('ck_workflow_owner_scope',
            '(project_id IS NOT NULL AND owner_team_id IS NULL) OR '
            '(project_id IS NULL AND owner_team_id IS NOT NULL)')
