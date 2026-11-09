"""Authenticated, transactional acceptance of write-ahead daemon reports."""
from typing import Any, TYPE_CHECKING
from contextlib import ExitStack
from ...persistence.daemon.reports import ReportReceiptConflict
from ..records import CommandEventMismatchError
from ..state import RegistryState


class ReportPredecessorMissing(ValueError):
    pass


class DurableReportMixin(RegistryState):
    if TYPE_CHECKING:
        def _handle_event_unlocked(self, sandbox_id: str, event: dict[str, Any], token: str | None) -> None: ...

    def handle_durable_report(self, sandbox_id: str, event: dict[str, Any], token: str | None, report_id: str, digest: str) -> None:
        self._hydrate_node(sandbox_id)
        streamed = event['type'] in {'run.output', 'run.output.batch', 'run.collaboration'}
        try:
            with ExitStack() as stack:
                if not streamed:
                    stack.enter_context(self.dispatch_lock)
                # Hold the local node lock before any database row locks.
                # Otherwise a heartbeat can hold it while waiting for our
                # command row, as our liveness update waits for the local lock.
                stack.enter_context(self.dispatch_scope([sandbox_id]))
                self._assert_authorized(sandbox_id, token)
                # Authorize metadata before returning even a previously stored receipt.
                record = self.daemon_store.get_command(event['commandId'])
                if not record:
                    raise CommandEventMismatchError('Report names an unknown command.')
                command = record['command']
                if record['nodeId'] != sandbox_id or any(command.get(key) != event.get(key) for key in ('sessionId', 'runId', 'agent')) or record.get('leaseId') != event.get('leaseId'):
                    raise CommandEventMismatchError('Report does not match its command ownership.')
                with self.daemon_store.report_ingest_scope(sandbox_id), self.store.mutation_scope(event['sessionId']), self.daemon_store.report_receipt_scope(sandbox_id, event['commandId'], report_id, digest) as apply:
                    if apply:
                        self._handle_event_unlocked(sandbox_id, {**event, '_durableReport': True}, token)
        except ReportReceiptConflict as error:
            raise CommandEventMismatchError(str(error)) from error
