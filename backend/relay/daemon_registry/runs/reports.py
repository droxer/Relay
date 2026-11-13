"""Authenticated, transactional acceptance of write-ahead daemon reports."""
from typing import Any, TYPE_CHECKING
from contextlib import ExitStack, nullcontext, contextmanager
from collections.abc import Iterator
from ...persistence.daemon.reports import ReportReceiptConflict
from ..records import CommandEventMismatchError
from ..state import RegistryState


class ReportPredecessorMissing(ValueError):
    pass


class DurableReportMixin(RegistryState):
    if TYPE_CHECKING:
        def _handle_event_unlocked(self, sandbox_id: str, event: dict[str, Any], token: str | None) -> None: ...

    @contextmanager
    def report_session_scope(self, session_id: str) -> Iterator[None]:
        """Missing thread history is a terminal conflict, not a retryable fault."""
        with ExitStack() as stack:
            try:
                stack.enter_context(self.store.mutation_scope(session_id))
            except KeyError as error:
                raise CommandEventMismatchError('Report thread no longer exists.') from error
            # Do not translate KeyErrors from processing: those remain retryable.
            yield

    def settle_acknowledged_stop(self, sandbox_id: str, event: dict[str, Any]) -> None:
        """Close stops aimed at a run whose cancellation Relay already holds.

        A daemon answers a stop for a run it no longer executes by reporting it
        cancelled again, under the original report identity. That replay is
        acknowledged from its receipt, so without this the newer stop stays
        leased and is redelivered every lease period for as long as it exists.
        """
        if event['type'] == 'run.cancelled':
            self.daemon_store.mark_cancel_commands_completed(sandbox_id, event['commandId'])

    def handle_durable_report(self,sandbox_id: str, event: dict[str, Any], token: str | None, report_id: str, digest: str) -> None:
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
                # The wire digest binds the original envelope. A previously
                # accepted identity needs no command or session history, but
                # must still match this authenticated node and exact payload.
                if self.daemon_store.report_was_accepted(sandbox_id, event['commandId'], report_id, digest):
                    self.settle_acknowledged_stop(sandbox_id, event)
                    return
                record = self.daemon_store.get_command(event['commandId'])
                if not record:
                    if self.daemon_store.accept_orphaned_cancel_report(sandbox_id, event, report_id, digest):
                        return
                    raise CommandEventMismatchError('Report names an unknown command.')
                command = record['command']
                if record['nodeId'] != sandbox_id or any(command.get(key) != event.get(key) for key in ('sessionId', 'runId', 'agent')) or record.get('leaseId') != event.get('leaseId'):
                    raise CommandEventMismatchError('Report does not match its command ownership.')
                # A redundant stop for an already-finished run only settles
                # the stop command. Its thread may have been deleted meanwhile;
                # the authenticated command and exact lease remain authority.
                redundant_stop = event['type'] == 'run.cancelled' and record['status'] in {'completed', 'failed'}
                session_scope = nullcontext() if redundant_stop else self.report_session_scope(event['sessionId'])
                with self.daemon_store.report_ingest_scope(sandbox_id), session_scope, self.daemon_store.report_receipt_scope(sandbox_id, event['commandId'], report_id, digest) as apply:
                    if apply:
                        self._handle_event_unlocked(sandbox_id, {**event, '_durableReport': True}, token)
        except ReportReceiptConflict as error:
            raise CommandEventMismatchError(str(error)) from error
