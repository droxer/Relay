"""Moving a round forward after a turn ends: claiming the terminal event and finalizing the turn.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.

Finalizing a turn is split into a pure *decide* step (``decide_turn_finalization``
and ``decide_completed_turn`` in ``finalization.py`` read the request and the
daemon event and return a small frozen description) and an *apply* step on the
mixin that persists it. Collaboration policy itself stays in
``collaboration.policy``/``work``; ``transitions.py`` applies its decisions and
``failure.py`` fails a request.
"""

from __future__ import annotations

from datetime import datetime, UTC
from typing import Any
from loguru import logger
from ...collaboration.work import (
    record_work_result, is_answer_turn,
)
from ...collaboration.policy import (
    ROUND_RESULT_REJECTED_STATE_KEY,
    ROUND_RESULT_STATE_KEY,
    report_reminder_transition,
    without_report_reminder,
)
from ...core.ids import new_relay_id
from ...persistence.events import relay_event
from ...sessions.agent_state import merge_agent_state
from .run_cursor import advanced_run_cursor
from .. import config
from ...core.next_steps import sanitize_next_steps
from ..records import (
    NEXT_STEPS_STATE_KEY,
    TERMINAL_CLAIM_ID_STATE_KEY,
)
from ..state import RegistryState
from .finalization import (
    FINALIZATION_ATTEMPTS_STATE_KEY,
    FINALIZATION_RETRY_AT_STATE_KEY,
    FINALIZATION_ESCALATION_ATTEMPTS,
    _TERMINAL_CLAIM_STATE_KEYS,
    finalization_retry_state,
    _without_keys,
    _agent_label,
    _turn_state_patch,
    _agent_completed_payload,
    session_already_terminal,
    TurnFinalization,
    decide_turn_finalization,
    CompletedTurn,
    decide_completed_turn,
)


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
        self.store.append_event(
            session["id"], relay_event("agent.completed", session["id"], payload),
            hydrate_events=False,
        )

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
        next_state = _with_next_steps(next_state, event, decision.succeeded)
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


def _with_next_steps(
    state: dict[str, Any], event: dict[str, Any], succeeded: bool
) -> dict[str, Any]:
    """Keep only the latest successful turn's suggestions: an earlier member's
    next step is stale once a later one has spoken."""
    steps = sanitize_next_steps(event.get("nextSteps")) if succeeded else []
    if steps:
        return {**state, NEXT_STEPS_STATE_KEY: steps}
    return {key: value for key, value in state.items() if key != NEXT_STEPS_STATE_KEY}
