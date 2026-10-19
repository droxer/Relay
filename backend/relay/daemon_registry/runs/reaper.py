"""Finding runs a node stopped reporting on, settling lost dispatches, and pruning old records.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

import time
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from datetime import datetime, timedelta, UTC
from typing import Any
from loguru import logger
from ...collaboration.models import (
    COLLABORATION_ADMISSION_EXPIRED_ERROR,
    COLLABORATION_ADMISSION_EXPIRED_OUTCOME,
    COLLABORATION_ADMISSION_EXPIRED_STATE_KEY,
    COLLABORATION_MANIFEST_STATE_KEY,
    COLLABORATION_NEW_SESSION_STATE_KEY,
)
from ...core.ids import new_relay_id
from ...persistence.daemon.rules import EXECUTION_INTERRUPTED_STATE_KEY
from ...persistence.task.execution import request_execution_owner
from ...core.daemon_capabilities import (
    DAEMON_CAPABILITY_EXECUTION_JOURNAL_REPORT,
    has_capability,
)
from ...sessions.controller import SessionController
from .. import config
from ..records import (
    TERMINAL_EVENT_STATE_KEY,
)
from ..state import RegistryState

# A run whose reaping raises is retried on every reap tick, forever: reaping
# failing is never exit evidence, so it must not release the reservation. To
# keep a poisoned run from hiding among routine warnings, consecutive failures
# are counted per run and escalated to an error log after this many in a row
# (and again at every further multiple of it). At the default liveness tick
# that is under a minute of a run failing every pass.
REAP_FAILURE_ESCALATION_THRESHOLD = 5
# The counts live in memory on the registry. A fleet only has as many failing
# runs as active runs, so this cap is generous; past it the run that failed
# least recently is forgotten (it restarts at one if it fails again).
REAP_FAILURE_TRACKING_LIMIT = 1024

TERMINAL_SESSION_STATUSES = ("completed", "failed", "cancelled")
TERMINAL_COMMAND_STATUSES = ("completed", "failed", "cancelled")
RECOVERY_BATCH_SIZE = 100


class _LoggedReapFailure(Exception):
    """A per-run step already logged its own failure; only count it."""


def select_orphaned_runs(
    runs: Iterable[dict[str, Any]], sandboxes: Mapping[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    """Active runs whose node is gone or retired."""
    orphaned: list[dict[str, Any]] = []
    for run in runs:
        node = sandboxes.get(run["nodeId"])
        if node and not node.get("retiredAt"):
            continue
        orphaned.append(run)
    return orphaned


def prepared_round_is_durable(request: dict[str, Any], session: dict[str, Any]) -> bool:
    """Whether a prepared request's collaboration round reached the session log."""
    manifest = (request.get("state") or {}).get(COLLABORATION_MANIFEST_STATE_KEY)
    round_id = manifest.get("roundId") if isinstance(manifest, dict) else None
    return bool(
        round_id
        and any(
            event.get("type") == "collaboration.round.started"
            and (event.get("manifest") or {}).get("roundId") == round_id
            for event in session.get("events", [])
        )
    )


def prepared_admission_expired(request: dict[str, Any], now: datetime) -> bool:
    updated_at = datetime.fromisoformat(request["updatedAt"])
    return (now - updated_at).total_seconds() >= config.PREPARED_ADMISSION_LEASE_SECONDS


def finalization_deferred(recovery_state: dict[str, Any], now: datetime) -> bool:
    """A finalizing request awaiting a person or a scheduled retry is left alone."""
    retry_at = recovery_state.get("_relay_finalization_retry_at")
    return bool(
        recovery_state.get("_relay_recovery_required")
        or (retry_at and datetime.fromisoformat(retry_at) > now)
    )


def dispatch_claim_held(
    request: dict[str, Any], has_staged_command: bool, now: datetime
) -> bool:
    """A dispatching request whose live claim has staged nothing yet is still owned."""
    claim_expires_at = (request.get("state") or {}).get("_relay_dispatch_claim_expires_at")
    return bool(
        not has_staged_command
        and isinstance(claim_expires_at, str)
        and datetime.fromisoformat(claim_expires_at) > now
    )


def lost_dispatch_event(
    command: dict[str, Any], sandbox: dict[str, Any], *, stopping: bool
) -> dict[str, Any]:
    """The terminal event a daemon that never received run.start would have sent."""
    # A daemon that reports its journal at registration would have named
    # this run if it had admitted it, so its silence means never received.
    # Older daemons cannot say, so claim only what Relay observed.
    reason = (
        "The run never started: its computer did not receive it."
        if has_capability(sandbox, DAEMON_CAPABILITY_EXECUTION_JOURNAL_REPORT)
        else "The computer stopped responding before the run reported progress."
    )
    return {
        "type": "run.cancelled" if stopping else "run.failed",
        "commandId": command["id"],
        "sessionId": command["sessionId"],
        "runId": command["runId"],
        "agent": command["agent"],
        **({"reason": reason} if stopping else {"error": reason, "exitCode": 1}),
    }


class RunReaperMixin(RegistryState):
    def reap_stale_runs(self, *, force: bool = True) -> None:
        if not force and time.monotonic() - self._last_reap_at < max(
            0.001, self.liveness_timeout_ms / 1000
        ):
            return
        # Recovery never holds the fleet-wide dispatch lock. Individual
        # transitions retain their own admission locks and durable claims.
        if not self._recovery_lock.acquire(blocking=False):
            return
        try:
            self._reap_stale_runs_unlocked(force=force)
        finally:
            self._recovery_lock.release()

    # -- consecutive failure tracking -------------------------------------

    def _reap_failure_counts(self) -> dict[str, int]:
        counts = getattr(self, "_reap_failures", None)
        if counts is None:
            counts = {}
            self._reap_failures = counts
        return counts

    def _note_reap_failure(self, key: str, **context: Any) -> int:
        """Count one more consecutive failure for ``key``; escalate past the threshold."""
        counts = self._reap_failure_counts()
        # Re-inserting keeps the dict ordered by most recent failure, so the
        # first key is the one to forget when the cap is reached.
        count = counts.pop(key, 0) + 1
        while len(counts) >= REAP_FAILURE_TRACKING_LIMIT:
            counts.pop(next(iter(counts)))
        counts[key] = count
        if count % REAP_FAILURE_ESCALATION_THRESHOLD == 0:
            logger.error(
                "Run reaping keeps failing; the run stays reserved and is retried",
                reap_key=key,
                consecutive_failures=count,
                **context,
            )
        return count

    def _clear_reap_failure(self, key: str) -> None:
        counts = getattr(self, "_reap_failures", None)
        if counts:
            counts.pop(key, None)

    # -- orphaned runs ------------------------------------------------------

    def _reap_orphaned_runs_unlocked(self) -> None:
        """Fail individual run records on retired or deleted nodes.

        When a node is fenced or removed while runs are still active, the
        corresponding run-request records may have already been cleaned up,
        but individual run records can linger and block the node from being
        fully deleted via `registry.delete`. This method marks those orphaned
        runs as failed so the deletion can proceed.
        """
        runs = self.daemon_store.list_active_runs(
            limit=RECOVERY_BATCH_SIZE, after_id=getattr(self, "_orphan_after_id", None)
        )
        self._orphan_after_id = runs[-1]["runId"] if len(runs) == RECOVERY_BATCH_SIZE else None
        for run in select_orphaned_runs(runs, self.sandboxes):
            self._reap_orphaned_run(run)

    def _reap_orphaned_run(self, run: dict[str, Any]) -> None:
        command_id = run.get("commandId")
        if not command_id:
            return
        command = self.daemon_store.get_command(command_id)
        if command and command.get("status") == "dispatched":
            self.cancel_active_run(run["nodeId"], run["sessionId"], "Runtime node retired; waiting for execution to stop.")
            return
        failure_key = f"orphan:{run['runId']}"
        try:
            self.daemon_store.mark_command_failed(
                run["nodeId"],
                {
                    "type": "run.failed",
                    "commandId": command_id,
                    "runId": run["runId"],
                    "sessionId": run.get("sessionId", ""),
                    "agent": run.get("agent", "unknown"),
                    "error": "Runtime node was retired or deleted while the run was active.",
                },
            )
            logger.info(
                "Reaped orphaned run on retired node",
                run_id=run["runId"],
                command_id=command_id,
                node_id=run["nodeId"],
            )
        except Exception as error:  # noqa: BLE001 - best-effort side effect; logged, retried by the next pass
            logger.warning(
                "Failed reaping orphaned run",
                run_id=run["runId"],
                node_id=run["nodeId"],
                error=str(error),
            )
            self._note_reap_failure(failure_key, run_id=run["runId"], node_id=run["nodeId"])
            return
        self._clear_reap_failure(failure_key)

    # -- run-request recovery -----------------------------------------------

    def _reap_stale_runs_unlocked(self, *, force: bool) -> None:
        monotonic_now = time.monotonic()
        if not force and monotonic_now - self._last_reap_at < max(
            0.001, self.liveness_timeout_ms / 1000
        ):
            self._maybe_prune_terminal_records(monotonic_now)
            return
        self._last_reap_at = monotonic_now
        self._maybe_prune_terminal_records(monotonic_now)
        self._reap_orphaned_runs_unlocked()
        for request in self._next_recovery_batch():
            self._recover_run_request(request)

    def _next_recovery_batch(self) -> list[dict[str, Any]]:
        if hasattr(self.daemon_store, "claim_recovery_requests"):
            return self.daemon_store.claim_recovery_requests(limit=RECOVERY_BATCH_SIZE)
        batch = self.daemon_store.list_active_run_requests(
            limit=RECOVERY_BATCH_SIZE, after_id=getattr(self, "_recovery_after_id", None)
        )
        self._recovery_after_id = batch[-1]["id"] if len(batch) == RECOVERY_BATCH_SIZE else None
        return batch

    def _recover_run_request(self, request: dict[str, Any]) -> None:
        """Recover one run request; a failure is logged and retried next pass."""
        failure_key = f"request:{request['id']}"
        try:
            self._recover_run_request_steps(request)
        except _LoggedReapFailure:
            self._note_reap_failure(failure_key, run_request_id=request["id"])
        except Exception:  # noqa: BLE001 - best-effort side effect; logged, retried by the next pass
            logger.exception("Run recovery failed", run_request_id=request["id"])
            self._note_reap_failure(failure_key, run_request_id=request["id"])
        else:
            self._clear_reap_failure(failure_key)

    def _recover_run_request_steps(self, request: dict[str, Any]) -> None:
        status = request.get("status")
        if status == "prepared":
            self._recover_prepared_request(request)
            return
        if status == "finalizing":
            self._recover_finalizing_request(request)
            return
        if status == "running" and (request.get("state") or {}).get("_relay_stop_command_id"):
            # Replay the durable intent if the coordinator died before
            # publishing its stable-id cancel command.
            self.cancel_active_run(
                request["nodeId"], request["sessionId"], request.get("error") or "Run stopped."
            )
        session = self.store.get_session(request["sessionId"])
        if session.get("status") in TERMINAL_SESSION_STATUSES:
            self._settle_request_for_terminal_session(request, session)
            return
        if status == "dispatching":
            staged = self.daemon_store.pending_command_for_run_request(request["id"])
            if dispatch_claim_held(request, bool(staged), datetime.now(UTC)):
                return
        command_id = request.get("currentCommandId")
        if not command_id:
            self._recover_unlinked_request(request)
            return
        self._recover_linked_request(request, command_id)

    @contextmanager
    def _delivery_failure_budget(self, request: dict[str, Any]) -> Iterator[None]:
        """Staged and linked-but-unpublished commands bypass the normal enqueue
        helper, but share its failure budget."""
        try:
            yield
        except Exception as error:
            try:
                self._record_follow_up_failure(request, error)
            except Exception:  # noqa: BLE001 - best-effort side effect; logged, retried by the next pass
                logger.exception("Could not record delivery recovery failure",
                                 run_request_id=request["id"])
            raise

    def _recover_prepared_request(self, request: dict[str, Any]) -> None:
        try:
            session = self.store.get_session(request["sessionId"])
        except KeyError:
            self.daemon_store.update_run_request(
                request["id"],
                {
                    "status": "failed",
                    "error": "Prepared collaboration session no longer exists.",
                },
            )
            return
        if session.get("status") in TERMINAL_SESSION_STATUSES:
            self.daemon_store.update_run_request(
                request["id"],
                {
                    "status": session["status"],
                    "error": (
                        "Prepared collaboration was not activated because "
                        f"the session is {session['status']}."
                    ),
                },
            )
            return
        if prepared_round_is_durable(request, session):
            self.activate_run_request(request["id"])
            return
        if prepared_admission_expired(request, datetime.now(UTC)):
            self._expire_prepared_admission(request)

    def _expire_prepared_admission(self, request: dict[str, Any]) -> None:
        state = {
            **(request.get("state") or {}),
            COLLABORATION_ADMISSION_EXPIRED_STATE_KEY: True,
        }
        self.daemon_store.update_run_request(
            request["id"],
            {
                "status": "failed",
                "error": COLLABORATION_ADMISSION_EXPIRED_ERROR,
                "state": state,
            },
        )
        if state.get(COLLABORATION_NEW_SESSION_STATE_KEY):
            SessionController(
                self.store,
                task_store=self.task_store,
                task_id=request.get("taskId"),
                task_execution_owner=request_execution_owner(request),
            ).fail_session(
                request["sessionId"],
                COLLABORATION_ADMISSION_EXPIRED_OUTCOME,
            )

    def _recover_finalizing_request(self, request: dict[str, Any]) -> None:
        recovery_state = request.get("state") or {}
        if finalization_deferred(recovery_state, datetime.now(UTC)):
            return
        terminal_event = recovery_state.get(TERMINAL_EVENT_STATE_KEY)
        if not isinstance(terminal_event, dict):
            command = self.daemon_store.get_command(request.get("currentCommandId")) if request.get("currentCommandId") else None
            terminal_event = ((command or {}).get("command") or {}).get("_terminalEvent")
        if not isinstance(terminal_event, dict):
            self.daemon_store.update_run_request_if_status(request["id"], "finalizing", {
                "state": {**recovery_state, "_relay_recovery_required": True,
                          "_relay_recovery_reason": "missing_terminal_evidence"},
            })
            return
        # Reaping runs inside monitor_nodes(), which most routes call, so one
        # request that cannot be finalized must not take the rest of the API
        # down with it. Log and move on; the claim lease brings it back on the
        # next pass.
        try:
            self._claim_and_advance_run_request(terminal_event)
        except Exception as error:  # noqa: BLE001 - best-effort side effect; logged, retried by the next pass
            logger.exception(
                "Failed finalizing a stale run request",
                run_request_id=request.get("id"),
                node_id=request.get("nodeId"),
                error=str(error),
            )
            raise _LoggedReapFailure from error

    def _settle_request_for_terminal_session(
        self, request: dict[str, Any], session: dict[str, Any]
    ) -> None:
        if (
            session["status"] == "completed"
            and not request.get("currentCommandId")
            and request.get("currentIndex", 0) >= len(request["assignments"])
        ):
            # Closeout may have persisted the session before its task write
            # failed. Replay the original completion; repair_completion fences
            # newer human decisions.
            if not self._follow_up_backing_off(request):
                self._follow_up_run_request(request)
            return
        if session["status"] == "failed":
            SessionController(
                self.store, task_store=self.task_store, task_id=request.get("taskId"),
                task_execution_owner=request_execution_owner(request),
            ).fail_session(session["id"], session.get("finalOutcome") or "Execution failed.")
        command_record = self.daemon_store.get_command(request.get("currentCommandId")) if request.get("currentCommandId") else None
        terminal_event = ((command_record or {}).get("command") or {}).get("_terminalEvent")
        if command_record and command_record.get("status") in TERMINAL_COMMAND_STATUSES and isinstance(terminal_event, dict):
            self._claim_and_advance_run_request(terminal_event)
            return
        if command_record and self._settle_lost_dispatch(request, command_record, stopping=True):
            return
        self._suppress_delivery_for_terminal_session(request, session, command_record)

    def _suppress_delivery_for_terminal_session(
        self,
        request: dict[str, Any],
        session: dict[str, Any],
        command_record: dict[str, Any] | None,
    ) -> None:
        staged = command_record or self.daemon_store.pending_command_for_run_request(request["id"])
        reason = f"Collaboration delivery was suppressed because the session is {session['status']}."
        patch: dict[str, Any] = {"status": session["status"], "error": reason}
        event = None
        if staged:
            command = staged["command"]
            event = {
                "type": "run.cancelled", "commandId": command["id"],
                "sessionId": command["sessionId"], "runId": command["runId"],
                "agent": command["agent"], "reason": reason,
            }
            # Fence delivery and retain the evidence before closing the
            # projection. A crash can replay normal finalization instead of
            # stranding a terminal request with a running agent.
            patch = {
                **patch,
                "status": "finalizing", "currentCommandId": command["id"],
                "currentRunId": command["runId"], "currentAgent": command["agent"],
                "state": {**request.get("state", {}), TERMINAL_EVENT_STATE_KEY: event},
            }
        terminalized = self.daemon_store.update_run_request_if_status(
            request["id"], request["status"], patch, require_undelivered=True,
        )
        if terminalized and event:
            self.daemon_store.mark_command_cancelled(request["nodeId"], event)
            self._claim_and_advance_run_request(event)

    def _recover_unlinked_request(self, request: dict[str, Any]) -> None:
        staged = self.daemon_store.pending_command_for_run_request(request["id"])
        if not staged:
            if not self._follow_up_backing_off(request):
                self._follow_up_run_request(request)
            return
        if self._follow_up_backing_off(request):
            return
        with self._delivery_failure_budget(request):
            self._redeliver_staged_command(request, staged)

    def _redeliver_staged_command(self, request: dict[str, Any], staged: dict[str, Any]) -> None:
        command = staged["command"]
        session = self.store.get_session(request["sessionId"])
        has_started = any(
            agent_run.get("id") == command["runId"]
            for agent_run in session.get("agentRuns", [])
        )
        if not has_started:
            claim = self._claim_staged_command(request["id"], command)
            if not claim:
                return
            request, command = claim
            if not (request.get("taskId") and command.get("reportExecutionStarted")):
                self._ensure_agent_started_for_command(request, command)
        linked = self.daemon_store.update_run_request_if_claimed(
            request["id"],
            "_relay_dispatch_claim_id",
            command.get("_dispatchClaimId", ""),
            self._run_request_command_link(command),
        )
        if not linked:
            claim = self._claim_staged_command(command["_runRequestId"], command)
            if not claim:
                return
            claimed, command = claim
            linked = self.daemon_store.update_run_request_if_claimed(
                claimed["id"],
                "_relay_dispatch_claim_id",
                command["_dispatchClaimId"],
                self._run_request_command_link(command),
            )
            if not linked:
                return
        published = self.daemon_store.publish_command(command["id"], request_id=linked["id"])
        if published:
            self._track_active_command(staged["nodeId"], command)

    def _claim_staged_command(
        self, run_request_id: str, command: dict[str, Any]
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """Claim dispatch of a run request and stamp the claim on its staged command."""
        claimed = self.daemon_store.claim_run_request_dispatch(
            run_request_id,
            new_relay_id("claim"),
            config.DISPATCH_CLAIM_LEASE_SECONDS,
        )
        if not claimed:
            return None
        claimed_command = {
            **command,
            "_dispatchClaimId": claimed["state"]["_relay_dispatch_claim_id"],
        }
        self.daemon_store.update_staged_command(claimed_command["id"], claimed_command)
        return claimed, claimed_command

    def _recover_linked_request(self, request: dict[str, Any], command_id: str) -> None:
        command_record = self.daemon_store.get_command(command_id)
        if command_record and command_record.get("status") == "pending":
            if self._follow_up_backing_off(request):
                return
            with self._delivery_failure_budget(request):
                published = self.daemon_store.publish_command(
                    command_id, request_id=request["id"]
                )
                if published:
                    self._track_active_command(
                        command_record["nodeId"], command_record["command"]
                    )
        if command_record and command_record.get("status") in TERMINAL_COMMAND_STATUSES:
            terminal_event = command_record["command"].get("_terminalEvent")
            if isinstance(terminal_event, dict):
                self._claim_and_advance_run_request(terminal_event)
                return
        sandbox = self.sandboxes.get(request["nodeId"])
        if not sandbox:
            self._fail_run_request(
                request, f"Daemon node {request['nodeId']} disappeared."
            )
            return
        if command_record and self._settle_lost_dispatch(
            request,
            command_record,
            stopping=bool((request.get("state") or {}).get("_relay_stop_command_id")),
        ):
            return
        # A node heartbeat can land on a different backend replica from this
        # reaper. Command leases are the durable ownership signal, so
        # replica-local liveness must not make the run terminal.
        outcome = self._stale_run_outcome(request)
        if outcome:
            self.cancel_active_run(request["nodeId"], request["sessionId"], outcome)
            self._fail_run_request(request, outcome)

    # -- lost dispatches ----------------------------------------------------

    def _settle_lost_dispatch(
        self, request: dict[str, Any], command_record: dict[str, Any], *, stopping: bool
    ) -> bool:
        """Close a delivered run.start that no daemon is executing.

        A poll response the daemon never read leaves run.start dispatched with
        nobody running it. It is never redelivered (that could run the agent
        twice) and a daemon that never saw it never acknowledges a stop, so the
        run would hold its node's slot forever.

        Timeout and lost liveness are not exit evidence, but this is: the run
        never showed a sign of life (no lease renewal, run.executing, or output
        ever stamped `currentProgressAt`) and its lease lapsed a full lease
        period ago on a node that is still heartbeating. A run the daemon did
        receive always leaves progress behind, including one whose terminal
        event is still retrying (the daemon stops renewing those), so a
        finished run is never relabelled as lost. The reaper records the
        terminal event that daemon would have sent.
        """
        confirmed = self._confirm_lost_dispatch(request, command_record)
        if not confirmed:
            return False
        sandbox, fresh_command = confirmed
        command = fresh_command.get("command") or {}
        event = lost_dispatch_event(command, sandbox, stopping=stopping)
        mark_terminal = (
            self.daemon_store.mark_command_cancelled
            if stopping
            else self.daemon_store.mark_command_failed
        )
        if not mark_terminal(request["nodeId"], event):
            return False
        logger.warning(
            "Settled a run.start its daemon never received",
            node_id=request["nodeId"],
            command_id=command["id"],
            run_id=command["runId"],
            outcome=event["type"],
        )
        self.active_commands.pop(command["id"], None)
        self.daemon_store.mark_cancel_commands_completed(request["nodeId"], command["id"])
        if not self._claim_and_advance_run_request(event):
            self.clear_run_output(command["runId"])
        return True

    def _confirm_lost_dispatch(
        self, request: dict[str, Any], command_record: dict[str, Any]
    ) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """The live node and fresh command record when a dispatch is still lost."""
        if not self._looks_lost(request, command_record):
            return None
        self._refresh_persisted_liveness(request["nodeId"])
        sandbox = self.sandboxes.get(request["nodeId"])
        if not sandbox or not self._liveness(sandbox)["online"]:
            return None
        # Re-read after the liveness refresh: a heartbeat that landed since the
        # reaper's first read renews the lease and records progress.
        fresh_request = self.daemon_store.get_run_request(request["id"])
        fresh_command = self.daemon_store.get_command(command_record["id"])
        if (
            not fresh_request
            or not fresh_command
            or fresh_command.get("leaseExpiresAt") != command_record.get("leaseExpiresAt")
            or not self._looks_lost(fresh_request, fresh_command)
        ):
            return None
        return sandbox, fresh_command

    def _looks_lost(self, request: dict[str, Any], command_record: dict[str, Any]) -> bool:
        lease_expires_at = command_record.get("leaseExpiresAt")
        return bool(
            command_record.get("status") == "dispatched"
            and (command_record.get("command") or {}).get("type") == "run.start"
            and not request.get("currentProgressAt")
            # The daemon said it received this run; it was not lost in transit.
            and not (request.get("state") or {}).get(EXECUTION_INTERRUPTED_STATE_KEY)
            and lease_expires_at
            and self._age_ms(lease_expires_at) > config.LOST_DISPATCH_GRACE_SECONDS * 1000
        )

    def _stale_run_outcome(self, request: dict[str, Any]) -> str | None:
        """Name why a run should be reaped, or None while it is still allowed to run.

        A long agent turn is normal work, so the idle clock runs from the last
        progress the run reported and only falls back to dispatch time while it
        has reported none. The absolute cap still runs from dispatch, so a run
        that streams forever without finishing is not immortal.
        """
        current_started_at = request.get("currentStartedAt")
        if not current_started_at:
            return None
        # Idle is checked first: a quiet run is diagnosed more precisely by how
        # long it has been silent than by how long it has existed.
        idle_since = request.get("currentProgressAt") or current_started_at
        if self._age_ms(idle_since) > config.DAEMON_RUN_TIMEOUT_MS:
            return "Daemon run timed out."
        if self._age_ms(current_started_at) > config.DAEMON_RUN_MAX_DURATION_MS:
            return "Daemon run exceeded its maximum duration."
        return None

    def _maybe_prune_terminal_records(self, monotonic_now: float) -> None:
        if not hasattr(self.daemon_store, "prune_terminal_records"):
            return
        if monotonic_now - self._last_prune_at < config.DAEMON_RECORD_PRUNE_INTERVAL_SECONDS:
            return
        self._last_prune_at = monotonic_now
        self.daemon_store.prune_terminal_records(
            retention_seconds=config.DAEMON_COMMAND_RETENTION_SECONDS,
            per_node_limit=config.DAEMON_TERMINAL_RECORD_LIMIT,
            run_request_retention_seconds=config.DAEMON_RUN_REQUEST_RETENTION_SECONDS,
        )
        self._maybe_compact_session_output()

    def _maybe_compact_session_output(self) -> None:
        """Opt-in: redact streamed output of runs completed long ago.

        Off unless RELAY_SESSION_OUTPUT_RETENTION_DAYS is set. A failed sweep
        is logged and retried on the next tick; it must never stop reaping.
        """
        compact = getattr(self.store, "compact_completed_run_output", None)
        if config.SESSION_OUTPUT_RETENTION_DAYS <= 0 or compact is None:
            return
        older_than = datetime.now(UTC) - timedelta(
            days=config.SESSION_OUTPUT_RETENTION_DAYS
        )
        try:
            redacted = compact(older_than=older_than)
        except Exception:  # noqa: BLE001 - maintenance must not break reaping
            logger.exception("Session output compaction sweep failed")
            return
        if redacted:
            logger.info("Compacted streamed run output", events=redacted)
