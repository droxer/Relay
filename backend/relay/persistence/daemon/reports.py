"""Receipt and report effects share the caller's thread transaction."""
from collections.abc import Iterator
from contextlib import contextmanager
from sqlalchemy import insert, select
from ..engine import store_transaction
from ..tables.daemon_reports import report_receipts
from .state import DaemonStoreState


class ReportReceiptConflict(ValueError):
    pass


class ReportReceiptRows(DaemonStoreState):
    @contextmanager
    def report_ingest_scope(self, node_id: str) -> Iterator[None]:
        """Keep node observation ahead of thread/command locks across replicas."""
        with store_transaction(self.engine) as conn:
            conn.execute(select(self.nodes.c.id).where(self.nodes.c.id == node_id).with_for_update()).first()
            yield

    def report_was_accepted(self, node_id: str, command_id: str, report_id: str, digest: str) -> bool:
        """Authenticate a retry using its immutable, payload-bound receipt."""
        with store_transaction(self.engine) as conn:
            receipt = conn.execute(select(report_receipts.c.node_id, report_receipts.c.digest).where(
                report_receipts.c.command_id == command_id,
                report_receipts.c.report_id == report_id,
            )).mappings().first()
            if receipt is None:
                return False
            if receipt['node_id'] != node_id or receipt['digest'] != digest:
                raise ReportReceiptConflict('Report identity already accepted with a different owner or payload.')
            return True

    @contextmanager
    def report_receipt_scope(self, node_id: str, command_id: str, report_id: str, digest: str) -> Iterator[bool]:
        with store_transaction(self.engine) as conn:
            # Thread lock precedes command lock, as in output_sequence_scope.
            command = conn.execute(select(self.commands.c.id).where(self.commands.c.id == command_id).with_for_update()).first()
            if self.report_was_accepted(node_id, command_id, report_id, digest):
                yield False
                return
            if command is None:
                raise ReportReceiptConflict('Report names an unknown command.')
            yield True
            conn.execute(insert(report_receipts).values(command_id=command_id, report_id=report_id, node_id=node_id, digest=digest))
