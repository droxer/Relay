"""Moving a round forward after a turn ends: applying collaboration policy decisions, repairs, lead plans, and failure.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.

Finalizing a turn is split into a pure *decide* step (``decide_turn_finalization``
and ``decide_completed_turn`` read the request and the daemon event and return a
small frozen description) and an *apply* step on the mixin that persists it.
Collaboration policy itself stays in ``collaboration.policy``/``work``; this
module only applies its decisions.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta, UTC
from typing import Any
from loguru import logger
from ..collaboration.models import (
    COLLABORATION_MANIFEST_STATE_KEY,
)
from ..collaboration.work import (
    WORK_PROTOCOL, WORK_PLAN_ERROR,
    record_work_result, validate_work_result, compile_proposed_plan,
    is_answer_turn,
)
from ..collaboration.policy import (
    REPAIR_COUNT_STATE_KEY,
    ROUND_RESULT_REJECTED_STATE_KEY,
    ROUND_RESULT_REJECTIONS,
    ROUND_RESULT_STATE_KEY,
    advance_after_success,
    decide_failure,
    is_question,
    next_work_transition,
    report_reminder_transition,
    without_report_reminder,
)
from ..core.ids import new_relay_id, now_iso
from ..persistence.task_execution import (
    request_execution_owner,
)
from ..persistence.stores import (
    relay_event,
)
from ..services.project_context import (
    context_suggestions_from_run,
    merge_context_suggestions,
)
from ..sessions.controller import SessionController, initial_agent_state, merge_agent_state
from ..collaboration.manifest import compile_assignment_work_graph, create_round_manifest
from ..services.project_setup_result import completed_setup
from .run_cursor import advanced_run_cursor
from . import config
from .records import (
    ARTIFACT_SNAPSHOT_STATE_KEY,
    FOLLOW_UP_FAILURE_STATE_KEY,
    TERMINAL_CLAIM_EXPIRES_STATE_KEY,
    TERMINAL_CLAIM_ID_STATE_KEY,
    TERMINAL_EVENT_STATE_KEY,
    is_human_started_round,
)
from .state import RegistryState


FINALIZATION_ATTEMPTS_STATE_KEY = "_relay_finalization_attempts"
FINALIZATION_RETRY_AT_STATE_KEY = "_relay_finalization_retry_at"
RECOVERY_REQUIRED_STATE_KEY = "_relay_recovery_required"
FINALIZATION_RETRY_BASE_SECONDS = 5
FINALIZATION_RETRY_MAX_SECONDS = 300
FINALIZATION_RETRY_MAX_EXPONENT = 6
# A finalization that has failed this many times in a row is no longer a
# transient blip: its backoff (5 + 10 + 20 + 40 + 80 s) has spanned about two
# and a half minutes, longer than a database failover or a replica restart.
# From this attempt on the request is flagged ``_relay_recovery_required`` for a
# person, and every further failure is logged at error level with its attempt
# count so a permanently failing finalization is visible in the logs. Retrying
# never stops: releasing the reservation needs daemon exit evidence or a
# recorded human assertion. Once the backoff reaches its 300 s cap the error
# repeats at most every five minutes, which keeps it visible without flooding.
FINALIZATION_ESCALATION_ATTEMPTS = 5

_TERMINAL_CLAIM_STATE_KEYS = (
    TERMINAL_EVENT_STATE_KEY,
    TERMINAL_CLAIM_ID_STATE_KEY,
    TERMINAL_CLAIM_EXPIRES_STATE_KEY,
)
_TURN_TRANSIENT_STATE_KEYS = (
    ARTIFACT_SNAPSHOT_STATE_KEY,
    *_TERMINAL_CLAIM_STATE_KEYS,
    FOLLOW_UP_FAILURE_STATE_KEY,
)
_TERMINAL_SESSION_STATUSES = ("completed", "failed", "cancelled")


def finalization_retry_state(state: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Schedule the next finalization attempt with capped exponential backoff."""
    attempts = int(state.get(FINALIZATION_ATTEMPTS_STATE_KEY) or 0) + 1
    delay = min(
        FINALIZATION_RETRY_MAX_SECONDS,
        FINALIZATION_RETRY_BASE_SECONDS * 2 ** min(attempts - 1, FINALIZATION_RETRY_MAX_EXPONENT),
    )
    retry_at = (now + timedelta(seconds=delay)).isoformat()
    return {
        **state,
        FINALIZATION_ATTEMPTS_STATE_KEY: attempts,
        FINALIZATION_RETRY_AT_STATE_KEY: retry_at,
        RECOVERY_REQUIRED_STATE_KEY: attempts >= FINALIZATION_ESCALATION_ATTEMPTS,
        TERMINAL_CLAIM_EXPIRES_STATE_KEY: retry_at,
    }


def _without_keys(state: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: value for key, value in state.items() if key not in keys}


def _agent_label(assignment: dict[str, Any]) -> str:
    # Agent-first assignments carry agentId/executorKind and no "agent" key, so
    # indexing it raised before the request could be marked failed — leaving it
    # finalizing forever. Resolve the label the way scheduling.py does.
    return (
        assignment.get("agentDisplayName")
        or assignment.get("executorKind")
        or assignment.get("agent")
        or "Agent"
    )


def _turn_state_patch(event: dict[str, Any], agent_log: str, exit_code: Any) -> dict[str, Any]:
    return {
        "agent_logs": [agent_log],
        "last_exit_code": exit_code,
        "token_usage": event.get("tokenUsage"),
    }


def _agent_completed_payload(
    event: dict[str, Any],
    assignment: dict[str, Any],
    *,
    status: str,
    exit_code: Any,
    agent_log: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "runId": event["runId"],
        "agent": event["agent"],
        "status": status,
        "exitCode": exit_code,
        "agentLog": agent_log,
        **(details or {}),
        "tokenUsage": event.get("tokenUsage"),
        **({"runtimeSessionId": event["runtimeSessionId"]} if event.get("runtimeSessionId") else {}),
        "assignmentId": assignment.get("assignmentId"),
    }


def session_already_terminal(session: dict[str, Any]) -> bool:
    return bool(
        session.get("status") in _TERMINAL_SESSION_STATUSES
        or session.get("deletionRequestedAt")
    )


@dataclass(frozen=True)
class TurnFinalization:
    """What a terminal daemon event means for its request's current turn."""

    event: dict[str, Any]
    state: dict[str, Any]
    assignment: dict[str, Any]
    artifact_snapshot: Any
    already_recorded: bool


def decide_turn_finalization(
    run_request: dict[str, Any], event: dict[str, Any], session: dict[str, Any]
) -> TurnFinalization:
    already_recorded = any(
        item.get("type") == "agent.completed" and item.get("runId") == event["runId"]
        for item in session.get("events", [])
    )
    assignment = run_request["assignments"][run_request.get("currentIndex", 0)]
    raw_state = run_request["state"]
    state = _without_keys(dict(raw_state), _TURN_TRANSIENT_STATE_KEYS)
    if state.get("_relay_stop_command_id"):
        # Any terminal acknowledgement proves exit, but a late success
        # must not override the durable stop decision or start a successor.
        event = {**event, "type": "run.cancelled", "reason": run_request.get("error") or "Run stopped."}
    return TurnFinalization(
        event=event,
        state=state,
        assignment=assignment,
        artifact_snapshot=raw_state.get(ARTIFACT_SNAPSHOT_STATE_KEY),
        already_recorded=already_recorded,
    )


@dataclass(frozen=True)
class CompletedTurn:
    """How a completed (not failed/cancelled) turn's report should be applied."""

    succeeded: bool
    uses_work_protocol: bool
    work_result: Any
    round_result: dict[str, Any] | None
    rejected_reason: str | None


def decide_completed_turn(
    run_request: dict[str, Any],
    event: dict[str, Any],
    *,
    reports_round_result: bool,
    reported_round_result: dict[str, Any] | None,
) -> CompletedTurn:
    uses_work_protocol = bool((run_request.get("state") or {}).get(WORK_PROTOCOL))
    # An agent that asked its human and then exited badly still asked: the
    # question is the turn's result, and the exit code after it is noise
    # (a timeout, a runtime quirk). Failing the run would drop the question
    # the daemon already consumed and strand the task.
    succeeded = event["exitCode"] == 0 or (
        reports_round_result and is_question(reported_round_result)
    )
    work_result = None
    if uses_work_protocol and succeeded:
        envelope = event.get("roundResult")
        work_result = validate_work_result(envelope.get("work") if isinstance(envelope, dict) else None)
    # Exactly one assignment speaks for the whole round: the last writable
    # member. Earlier per-member verdicts are deliberately ignored.
    round_result = reported_round_result if succeeded and reports_round_result else None
    rejected = event.get("roundResultRejected")
    rejected_reason = (
        rejected["reason"]
        if reports_round_result
        and not round_result
        and isinstance(rejected, dict)
        and rejected.get("reason") in ROUND_RESULT_REJECTIONS
        else None
    )
    return CompletedTurn(
        succeeded=succeeded,
        uses_work_protocol=uses_work_protocol,
        work_result=work_result,
        round_result=round_result,
        rejected_reason=rejected_reason,
    )


@dataclass(frozen=True)
class FailingRunTarget:
    """The run and command a failing request must terminalize."""

    run_request: dict[str, Any]
    run_id: str | None
    command_id: str | None
    command: dict[str, Any] | None


def undelivered_failure_event(
    run_request: dict[str, Any],
    outcome: str,
    run_id: str | None,
    command_id: str,
    command: dict[str, Any] | None,
) -> dict[str, Any]:
    command_payload = (command or {}).get("command") or {}
    return {
        "type": "run.failed",
        "commandId": command_id,
        "sessionId": run_request["sessionId"],
        "runId": run_id or command_payload.get("runId", ""),
        "agent": run_request.get("currentAgent") or command_payload.get("agent", "codex"),
        "error": outcome,
        "exitCode": 1,
        # A concurrent publisher/poll must not turn a locally observed
        # pending command into permission to release a delivered run.
        **({"_requireUndelivered": True} if command and command.get("status") in ("pending", "queued") else {}),
    }


class RunProgressionMixin(RegistryState):
    def _claim_and_advance_run_request(self, event: dict[str, Any]) -> bool:
        run_request = self.daemon_store.claim_terminal_run_request(
            event["commandId"],
            event,
            new_relay_id("claim"),
            config.TERMINAL_CLAIM_LEASE_SECONDS,
        )
        if not run_request:
            return False
        try:
            self._advance_run_request(run_request, event)
        except Exception:
            state = finalization_retry_state(dict(run_request.get("state") or {}), datetime.now(UTC))
            attempts = state[FINALIZATION_ATTEMPTS_STATE_KEY]
            if attempts >= FINALIZATION_ESCALATION_ATTEMPTS:
                # Keep retrying (the reservation stays held), but make a
                # finalization that keeps failing impossible to miss.
                logger.opt(exception=True).error(
                    "Run finalization keeps failing; still retrying",
                    request_id=run_request.get("id"),
                    command_id=event.get("commandId"),
                    attempts=attempts,
                    retry_at=state[FINALIZATION_RETRY_AT_STATE_KEY],
                )
            self.daemon_store.update_run_request_if_claimed(
                run_request["id"], TERMINAL_CLAIM_ID_STATE_KEY,
                state[TERMINAL_CLAIM_ID_STATE_KEY], {"state": state},
            )
            raise
        return True

    def _close_terminal_session_agent(self, event: dict[str, Any]) -> None:
        """Project confirmed exit/suppressed delivery without changing thread outcome.

        Call only while owning the request transition, after terminal command
        evidence has been persisted. A failed session alone is not exit evidence.
        """
        session = self.store.get_session(event["sessionId"])
        run = next(
            (run for run in session.get("agentRuns", [])
             if run["id"] == event["runId"] and run.get("status") == "running"),
            None,
        )
        if not run:
            return
        outcome = "cancelled" if event["type"] == "run.cancelled" else (
            "completed" if event["type"] == "run.completed" and event.get("exitCode") == 0 else "failed")
        payload = {
            "runId": run["id"], "agent": run["agent"], "status": outcome,
            "exitCode": event.get("exitCode", 130 if outcome == "cancelled" else 1),
            "agentLog": event.get("agentLog", run.get("agentLog", "")),
        }
        if event.get("tokenUsage"):
            payload["tokenUsage"] = event["tokenUsage"]
        if event.get("runtimeSessionId"):
            payload["runtimeSessionId"] = event["runtimeSessionId"]
        self.store.append_event(session["id"], relay_event("agent.completed", session["id"], payload))

    def _advance_run_request(
        self, run_request: dict[str, Any], event: dict[str, Any]
    ) -> None:
        terminal_claim_id = (run_request.get("state") or {}).get(
            TERMINAL_CLAIM_ID_STATE_KEY
        )
        if not terminal_claim_id:
            return
        fenced_request = self.daemon_store.update_run_request_if_claimed(
            run_request["id"],
            TERMINAL_CLAIM_ID_STATE_KEY,
            terminal_claim_id,
            {},
        )
        if not fenced_request:
            return
        run_request = fenced_request
        sandbox = self._finalization_sandbox(run_request["nodeId"])
        controller = self._controller_for_sandbox(sandbox, run_request.get("taskId"), run_request)
        try:
            session_before = self.store.get_session(run_request["sessionId"])
        except KeyError:
            self._finalize_vanished_session(run_request, event, terminal_claim_id)
            return
        if session_already_terminal(session_before):
            self._finalize_for_terminal_session(
                run_request, event, terminal_claim_id, session_before, controller
            )
            return
        turn = decide_turn_finalization(run_request, event, session_before)
        if not turn.already_recorded:
            self._record_project_setup_result(run_request, turn.event)
        if turn.event["type"] == "run.failed":
            self._finalize_failed_turn(
                run_request, turn, terminal_claim_id, sandbox, controller, session_before
            )
        elif turn.event["type"] == "run.cancelled":
            self._finalize_cancelled_turn(
                run_request, turn, terminal_claim_id, controller, session_before
            )
        else:
            self._finalize_completed_turn(
                run_request, turn, terminal_claim_id, sandbox, controller, session_before
            )

    def _finalization_sandbox(self, node_id: str) -> dict[str, Any]:
        sandbox = self.sandboxes.get(node_id)
        if not sandbox:
            self._hydrate_node(node_id)
            sandbox = self.sandboxes.get(node_id)
        if not sandbox:
            raise ValueError("Runtime node unavailable during finalization.")
        return sandbox

    def _finalize_vanished_session(
        self, run_request: dict[str, Any], event: dict[str, Any], terminal_claim_id: str
    ) -> None:
        outcome = f"Session {run_request['sessionId']} disappeared before run finalization."
        state = _without_keys(dict(run_request.get("state") or {}), _TERMINAL_CLAIM_STATE_KEYS)
        self.clear_run_output(event["runId"])
        self.active_commands.pop(event["commandId"], None)
        self.daemon_store.mark_cancel_commands_completed(
            run_request["nodeId"], event["commandId"]
        )
        self.daemon_store.update_run_request_if_claimed(
            run_request["id"],
            TERMINAL_CLAIM_ID_STATE_KEY,
            terminal_claim_id,
            {"status": "failed", "state": state, "error": outcome},
        )
        self.update_status(
            run_request["nodeId"], {"status": "ready", "lastError": outcome}
        )

    def _finalize_for_terminal_session(
        self,
        run_request: dict[str, Any],
        event: dict[str, Any],
        terminal_claim_id: str,
        session_before: dict[str, Any],
        controller: Any,
    ) -> None:
        # The human/session terminal decision wins over a late daemon
        # result. The command already retains the acknowledged result;
        # finish the agent projection and request bookkeeping, never reopen work or dispatch
        # another assignment during crash recovery. A stopped setup round
        # still closes its draft so the project is not left waiting.
        self._record_project_setup_result(run_request, event)
        if session_before.get("status") == "failed":
            controller.fail_session(session_before["id"], session_before.get("finalOutcome") or "Execution failed.")
        self._close_terminal_session_agent(event)
        self.active_commands.pop(event["commandId"], None)
        self.clear_run_output(event["runId"])
        self.daemon_store.mark_cancel_commands_completed(run_request["nodeId"], event["commandId"])
        status = "cancelled" if session_before.get("deletionRequestedAt") else session_before["status"]
        self.daemon_store.update_run_request_if_claimed(
            run_request["id"], TERMINAL_CLAIM_ID_STATE_KEY, terminal_claim_id,
            {"status": status, "error": session_before.get("finalOutcome")},
        )

    def _finalize_failed_turn(
        self,
        run_request: dict[str, Any],
        turn: TurnFinalization,
        terminal_claim_id: str,
        sandbox: dict[str, Any],
        controller: Any,
        session_before: dict[str, Any],
    ) -> None:
        event = turn.event
        agent_log = event.get("agentLog") or event["error"]
        exit_code = event.get("exitCode", 1)
        self.clear_run_output(event["runId"])
        next_state = (
            merge_agent_state(turn.state, _turn_state_patch(event, agent_log, exit_code))
            if turn.already_recorded
            else controller.record_agent_completed(
                run_request["sessionId"],
                turn.state,
                _agent_completed_payload(
                    event, turn.assignment, status="failed", exit_code=exit_code, agent_log=agent_log
                ),
            )
        )
        # Preserve deliverables when the agent process succeeded but the
        # daemon could not deliver every live output event. Failed events
        # without an explicit report retain the historical no-artifact
        # behavior, including legacy daemons and genuine agent failures.
        if isinstance(event.get("generatedFiles"), list):
            self._record_generated_workspace_artifacts(
                sandbox, run_request, event, turn.artifact_snapshot, turn.assignment
            )
        self._fail_after_turn(
            run_request, terminal_claim_id, next_state, event["error"],
            turn.assignment, controller, session_before,
        )

    def _finalize_cancelled_turn(
        self,
        run_request: dict[str, Any],
        turn: TurnFinalization,
        terminal_claim_id: str,
        controller: Any,
        session_before: dict[str, Any],
    ) -> None:
        event = turn.event
        agent_log = event.get("agentLog") or self.output_for_run(event["runId"])
        self.clear_run_output(event["runId"])
        if not turn.already_recorded:
            controller.record_agent_completed(
                run_request["sessionId"],
                turn.state,
                _agent_completed_payload(
                    event, turn.assignment, status="cancelled", exit_code=130, agent_log=agent_log
                ),
            )
        if session_before.get("status") != "cancelled":
            controller.cancel_session(
                run_request["sessionId"], event["reason"],
                actor_user_id=turn.state.get("_relay_stop_actor_user_id"),
            )
        self.daemon_store.update_run_request_if_claimed(
            run_request["id"],
            TERMINAL_CLAIM_ID_STATE_KEY,
            terminal_claim_id,
            {"status": "cancelled", "error": event["reason"]},
        )
        self.update_status(
            run_request["nodeId"], {"status": "ready", "lastError": event["reason"]}
        )

    def _finalize_completed_turn(
        self,
        run_request: dict[str, Any],
        turn: TurnFinalization,
        terminal_claim_id: str,
        sandbox: dict[str, Any],
        controller: Any,
        session_before: dict[str, Any],
    ) -> None:
        reports_round_result = self._assignment_reports_round_result(
            run_request["assignments"], run_request.get("currentIndex", 0)
        )
        decision = decide_completed_turn(
            run_request,
            turn.event,
            reports_round_result=reports_round_result,
            reported_round_result=self._round_result(turn.event) if reports_round_result else None,
        )
        next_state = self._record_completed_turn(run_request, turn, decision, sandbox, controller)
        if not decision.succeeded:
            outcome = f"{_agent_label(turn.assignment)} failed with exit code {turn.event['exitCode']}."
            self._fail_after_turn(
                run_request, terminal_claim_id, next_state, outcome,
                turn.assignment, controller, session_before,
            )
            return
        self._advance_after_completed_turn(
            run_request, terminal_claim_id, controller, turn.assignment, decision, next_state
        )

    def _record_completed_turn(
        self,
        run_request: dict[str, Any],
        turn: TurnFinalization,
        decision: CompletedTurn,
        sandbox: dict[str, Any],
        controller: Any,
    ) -> dict[str, Any]:
        """Record the turn's completion and fold its report into the round state."""
        event = turn.event
        agent_log = event.get("agentLog") or self.output_for_run(event["runId"])
        self.clear_run_output(event["runId"])
        details = {
            **({"workResult": decision.work_result} if decision.work_result else {}),
            **({"outputTruncated": True} if event.get("outputTruncated") else {}),
        }
        next_state = (
            merge_agent_state(turn.state, _turn_state_patch(event, agent_log, event["exitCode"]))
            if turn.already_recorded
            else controller.record_agent_completed(
                run_request["sessionId"],
                turn.state,
                _agent_completed_payload(
                    event, turn.assignment,
                    status="completed" if event["exitCode"] == 0 else "failed",
                    exit_code=event["exitCode"], agent_log=agent_log, details=details,
                ),
                fail_task=not decision.succeeded,
            )
        )
        if decision.succeeded:
            self._record_generated_workspace_artifacts(
                sandbox, run_request, event, turn.artifact_snapshot, turn.assignment
            )
        if decision.round_result:
            next_state = {**next_state, ROUND_RESULT_STATE_KEY: decision.round_result}
        if decision.rejected_reason is not None:
            # The daemon found a verdict file and refused it; say why on the
            # task instead of reporting the verdict as simply missing.
            next_state = {**next_state, ROUND_RESULT_REJECTED_STATE_KEY: decision.rejected_reason}
        if decision.succeeded and not turn.already_recorded:
            self._record_context_suggestions(run_request, event, turn.assignment)
        if decision.uses_work_protocol:
            next_state = record_work_result(
                next_state,
                turn.assignment,
                decision.work_result,
                answering=is_answer_turn(
                    run_request.get("state") or {}, run_request.get("currentIndex", 0)
                ),
            )
        return next_state

    def _fail_after_turn(
        self,
        run_request: dict[str, Any],
        terminal_claim_id: str,
        next_state: dict[str, Any],
        outcome: str,
        assignment: dict[str, Any],
        controller: Any,
        session_before: dict[str, Any],
    ) -> None:
        """Repair, continue past, or fail the round after a member's turn failed."""
        agent_label = _agent_label(assignment)
        if self._send_back_for_repair(
            run_request, terminal_claim_id, next_state, outcome, agent_label
        ):
            return
        if self._continue_after_non_action_failure(
            run_request, terminal_claim_id, next_state, outcome, agent_label,
            assignment.get("mode") or "action",
        ):
            return
        if session_before.get("status") != "failed":
            controller.fail_session(run_request["sessionId"], outcome)
        self.daemon_store.update_run_request_if_claimed(
            run_request["id"],
            TERMINAL_CLAIM_ID_STATE_KEY,
            terminal_claim_id,
            {"status": "failed", "state": next_state, "error": outcome},
        )
        self.update_status(
            run_request["nodeId"], {"status": "ready", "lastError": outcome}
        )

    def _advance_after_completed_turn(
        self,
        run_request: dict[str, Any],
        terminal_claim_id: str,
        controller: Any,
        assignment: dict[str, Any],
        decision: CompletedTurn,
        next_state: dict[str, Any],
    ) -> None:
        if decision.uses_work_protocol:
            assignments, next_index, next_state = self._apply_work_transition(
                run_request, controller, assignment, decision.work_result, next_state
            )
        else:
            assignments = run_request["assignments"]
            reminder = report_reminder_transition(
                run_request, assignment, next_state,
                unreported=decision.round_result is None
                and self._owes_round_result(run_request),
            )
            next_index, next_state = reminder or self._next_index_after_success(
                run_request, without_report_reminder(next_state)
            )
        updated = self.daemon_store.update_run_request_if_claimed(
            run_request["id"],
            TERMINAL_CLAIM_ID_STATE_KEY,
            terminal_claim_id,
            {**advanced_run_cursor(next_index, next_state), "assignments": assignments},
        )
        if not updated:
            return
        self._follow_up_run_request(updated)

    def _owes_round_result(self, run_request: dict[str, Any]) -> bool:
        """Whether the turn that just finished had to file the round's verdict."""
        return self._round_result_was_required(run_request) and self._assignment_reports_round_result(
            run_request["assignments"], run_request.get("currentIndex", 0)
        )

    def _apply_work_transition(
        self,
        run_request: dict[str, Any],
        controller: Any,
        assignment: dict[str, Any],
        work_result: Any,
        next_state: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], int, dict[str, Any]]:
        """Apply the work protocol's transition, adopting a lead plan if it carries one."""
        assignments = run_request["assignments"]
        transition = next_work_transition(run_request, assignment, work_result, next_state)
        next_state = transition.state
        if transition.plan is not None:
            assignments, next_state = self._adopt_lead_plan(
                run_request, controller, assignments, transition.plan, next_state
            )
            if WORK_PLAN_ERROR in next_state:
                transition = replace(transition, next_index=None)
        next_index = (
            len(assignments) if transition.next_index is None else transition.next_index
        )
        return assignments, next_index, next_state

    @staticmethod
    def _adopt_lead_plan(
        run_request: dict[str, Any],
        controller: Any,
        assignments: list[dict[str, Any]],
        plan: list[Any],
        next_state: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Compile the coordinator's plan into the round, or record why it was refused."""

        parent = next_state.get(COLLABORATION_MANIFEST_STATE_KEY) or {}
        parent_round_id = parent.get("roundId") or run_request["id"]
        try:
            planned = compile_assignment_work_graph(
                compile_proposed_plan(assignments, plan, parent_round_id),
                purpose="accomplish",
                team_snapshot=parent.get("teamSnapshot"),
            )
        except ValueError as error:
            return assignments, {**next_state, WORK_PLAN_ERROR: str(error)}
        manifest = {
            **create_round_manifest(
                source="lead_plan",
                purpose="accomplish",
                address=parent.get("address") or {"kind": "room"},
                assignments=planned,
                team_snapshot=parent.get("teamSnapshot"),
                project_snapshot=parent.get("projectSnapshot"),
                collaboration_id=parent.get("collaborationId"),
                round_id=f"{parent_round_id}_plan",
            ),
            "parentRoundId": parent.get("roundId"),
            "workScope": parent.get("workScope", {"kind": "thread"}),
            # The plan replaces the manifest; keep who started the round, or a
            # person's round would spend the unattended continuation budget.
            "humanStarted": is_human_started_round(parent),
        }
        controller.record_collaboration_round_started(run_request["sessionId"], manifest)
        return planned, {**next_state, COLLABORATION_MANIFEST_STATE_KEY: manifest}

    def _record_context_suggestions(
        self,
        run_request: dict[str, Any],
        event: dict[str, Any],
        assignment: dict[str, Any],
    ) -> None:
        """Keep the context lines a project run proposed for its owner to review."""
        reported = (event.get("roundResult") or {}).get("contextSuggestions")
        manifest = (run_request.get("state") or {}).get(
            COLLABORATION_MANIFEST_STATE_KEY
        ) or {}
        project_id = (manifest.get("projectSnapshot") or {}).get("projectId")
        if not reported or not project_id or manifest.get("projectSetup") or not self.project_store:
            return
        incoming = context_suggestions_from_run(
            reported,
            thread_id=run_request["sessionId"],
            run_id=event["runId"],
            agent_id=assignment.get("agentId"),
            created_at=now_iso(),
        )
        if not incoming:
            return
        try:
            self.project_store.add_context_suggestions(
                project_id,
                lambda latest: merge_context_suggestions(
                    latest.get("contextSuggestions"), incoming, latest.get("context") or ""
                ),
            )
        except Exception:  # noqa: BLE001 - best-effort side effect; logged, retried by the next pass
            # Advice is optional; the run's completion must not depend on it.
            logger.exception(
                "Could not record project context suggestions",
                project_id=project_id,
                run_id=event.get("runId"),
            )

    def _record_project_setup_result(
        self, run_request: dict[str, Any], event: dict[str, Any]
    ) -> None:
        """Fold a finished setup round's proposal into its project.

        Recorded for every terminal outcome so a failed or stopped draft
        never leaves the project waiting on a setup that will not come.
        """
        manifest = (run_request.get("state") or {}).get(
            COLLABORATION_MANIFEST_STATE_KEY
        ) or {}
        project_id = (manifest.get("projectSnapshot") or {}).get("projectId")
        if not manifest.get("projectSetup") or not project_id or not self.project_store:
            return

        exit_code = (
            event.get("exitCode", 0)
            if event["type"] == "run.completed"
            else event.get("exitCode") or 1
        )

        def change(project: dict[str, Any]) -> dict[str, Any] | None:
            current = project.get("setup") or {}
            draft_id = manifest["projectSetup"].get("draftId")
            if current.get("draftId") != draft_id:
                return None
            if current.get("threadId") not in (None, run_request["sessionId"]):
                return None
            updated = completed_setup(
                current, event.get("projectSetup"), exit_code=exit_code
            )
            return {**updated, "threadId": run_request["sessionId"]} if updated else None

        try:
            self.project_store.mutate_setup(project_id, change)
        except Exception:  # noqa: BLE001 - best-effort side effect; logged, retried by the next pass
            # The run's own completion must not fail because its project
            # moved on; the setup panel still reads the thread's status.
            logger.exception(
                "Could not record project setup result",
                project_id=project_id,
                run_id=event.get("runId"),
            )

    def _send_back_for_repair(
        self,
        run_request: dict[str, Any],
        terminal_claim_id: str,
        next_state: dict[str, Any],
        outcome: str,
        agent_label: str,
    ) -> bool:
        """Give the lead a turn to fix a teammate's failure. True if it was sent.

        A failed member used to end the whole run, discarding the work every
        earlier member already committed to the shared workspace. The lead owns
        the task, so it gets a bounded chance to repair. Every member then
        revalidates its contribution against the repaired workspace.
        """
        decision = decide_failure(
            run_request,
            next_state,
            outcome=outcome,
            agent_label=agent_label,
            mode=(
                run_request["assignments"][run_request.get("currentIndex", 0)].get(
                    "mode"
                )
                or "action"
            ),
            max_runtime_repairs=config.DAEMON_RUN_MAX_REPAIRS,
        )
        if decision.kind != "repair" or decision.next_index is None:
            return False
        updated = self.daemon_store.update_run_request_if_claimed(
            run_request["id"],
            TERMINAL_CLAIM_ID_STATE_KEY,
            terminal_claim_id,
            advanced_run_cursor(decision.next_index, decision.state),
        )
        if not updated:
            return False
        logger.info(
            "Sending the lead back to repair a failed teammate",
            request_id=run_request["id"],
            session_id=run_request["sessionId"],
            failed_index=run_request.get("currentIndex", 0),
            repair=decision.state[REPAIR_COUNT_STATE_KEY],
        )
        self._follow_up_run_request(updated)
        return True

    def _next_index_after_success(
        self, run_request: dict[str, Any], next_state: dict[str, Any]
    ) -> tuple[int, dict[str, Any]]:
        """Advance one step, or resume at the member whose failure was repaired."""
        return advance_after_success(run_request, next_state)

    def _continue_after_non_action_failure(
        self,
        run_request: dict[str, Any],
        terminal_claim_id: str,
        next_state: dict[str, Any],
        outcome: str,
        agent_label: str,
        mode: str,
    ) -> bool:
        """Keep collecting discussion/review results after one member fails."""
        decision = decide_failure(
            run_request,
            next_state,
            outcome=outcome,
            agent_label=agent_label,
            mode=mode,
            max_runtime_repairs=config.DAEMON_RUN_MAX_REPAIRS,
        )
        if decision.kind != "continue" or decision.next_index is None:
            return False
        updated = self.daemon_store.update_run_request_if_claimed(
            run_request["id"],
            TERMINAL_CLAIM_ID_STATE_KEY,
            terminal_claim_id,
            advanced_run_cursor(decision.next_index, decision.state),
        )
        if not updated:
            return False
        self._follow_up_run_request(
            updated, "The round completed with one or more participant failures."
        )
        return True

    def _fail_run_request(self, run_request: dict[str, Any], outcome: str, *, delivery_never_sent: bool = False) -> None:
        target = self._failing_run_target(run_request)
        run_request, run_id, command_id, command = (
            target.run_request, target.run_id, target.command_id, target.command
        )
        if command and command.get("status") == "dispatched" and not delivery_never_sent:
            # Timeout, loss of liveness, and retirement are not exit evidence.
            # Keep both reservations until the daemon acknowledges termination.
            self._cancel_active_run_unlocked(run_request["nodeId"], run_request["sessionId"], outcome)
            return
        if command_id and not self._terminalize_failed_command(
            run_request, outcome, run_id, command_id, command
        ):
            return
        if run_id:
            self.clear_run_output(run_id)
        controller = self._controller_for_failed_request(run_request)
        if run_id and run_request.get("currentAgent"):
            controller.record_agent_completed(
                run_request["sessionId"],
                run_request.get("state", initial_agent_state(run_request["taskGoal"])),
                {
                    "runId": run_id,
                    "agent": run_request["currentAgent"],
                    "status": "failed",
                    "exitCode": 1,
                    "agentLog": outcome,
                },
            )
        controller.fail_session(run_request["sessionId"], outcome)
        self.daemon_store.update_run_request(
            run_request["id"], {"status": "failed", "error": outcome}
        )
        # No terminal daemon event follows an undelivered request. Close its
        # setup here, after the request and session are definitively failed.
        self._record_project_setup_result(run_request, {"type": "run.failed", "exitCode": 1})
        self.update_status(
            run_request["nodeId"], {"status": "failed", "lastError": outcome}
        )

    def _failing_run_target(self, run_request: dict[str, Any]) -> FailingRunTarget:
        run_id = run_request.get("currentRunId")
        command_id = run_request.get("currentCommandId")
        if command_id:
            return FailingRunTarget(
                run_request, run_id, command_id, self.daemon_store.get_command(command_id)
            )
        command = self.daemon_store.pending_command_for_run_request(run_request["id"])
        if not command:
            return FailingRunTarget(run_request, run_id, command_id, command)
        # A dispatch can fail between staging and linking. Terminalize
        # its undelivered command too, without inventing a started run.
        staged_run_id = command["command"]["runId"]
        session_runs = self.store.get_session(run_request["sessionId"]).get("agentRuns", [])
        if any(run["id"] == staged_run_id for run in session_runs):
            run_id = staged_run_id
            run_request = {**run_request, "currentAgent": command["command"]["agent"]}
        return FailingRunTarget(run_request, run_id, command["command"]["id"], command)

    def _terminalize_failed_command(
        self,
        run_request: dict[str, Any],
        outcome: str,
        run_id: str | None,
        command_id: str,
        command: dict[str, Any] | None,
    ) -> bool:
        """Fail the request's command. False when another replica owns its evidence."""
        self.active_commands.pop(command_id, None)
        event = undelivered_failure_event(run_request, outcome, run_id, command_id, command)
        accepted = self.daemon_store.mark_command_failed(run_request["nodeId"], event)
        if not accepted:
            command_record = self.daemon_store.get_command(command_id)
            if command_record:
                # Another replica delivered or terminalized this command.
                # Keep its reservation; its evidence owns the next update.
                if run_id:
                    self.clear_run_output(run_id)
                return False
        self.daemon_store.mark_cancel_commands_completed(
            run_request["nodeId"], command_id
        )
        return True

    def _controller_for_failed_request(self, run_request: dict[str, Any]) -> Any:
        sandbox = self.sandboxes.get(run_request["nodeId"])
        if sandbox:
            return self._controller_for_sandbox(sandbox, run_request.get("taskId"), run_request)
        return SessionController(
            self.store,
            task_store=self.task_store,
            task_id=run_request.get("taskId"),
            task_execution_owner=request_execution_owner(run_request),
        )
