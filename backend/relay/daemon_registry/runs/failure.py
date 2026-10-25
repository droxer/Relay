"""Failing a run request: choosing the run it fails through and terminalizing an undelivered command.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from ...tasks.execution import request_execution_owner
from ...sessions.agent_state import initial_agent_state
from ...sessions.controller import SessionController
from ..state import RegistryState


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



class RunFailureMixin(RegistryState):
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
