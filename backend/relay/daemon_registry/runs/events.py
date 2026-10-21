"""Ingesting daemon run events and buffering streamed output.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

import time
from typing import Any
from loguru import logger
from ...core.ids import now_iso
from ...persistence.tables.daemon import ACTIVE_RUN_REQUEST_STATUSES
from ...persistence.task.execution import request_execution_owner
from ...persistence.events import relay_event
from ...persistence.events import relay_task_event
from .. import config
from ..state import RegistryState


class EventIngestMixin(RegistryState):
    def handle_event(
        self, sandbox_id: str, event: dict[str, Any], token: str | None
    ) -> None:
        self._hydrate_node(sandbox_id)
        lock = (
            self.dispatch_scope([sandbox_id])
            if event.get("type") in self._STREAMED_EVENT_TYPES
            else self.dispatch_lock
        )
        with lock:
            self._handle_event_unlocked(sandbox_id, event, token)

    # Event types that carry streamed output. They take only the node lock and
    # may arrive replayed after their command reached a terminal status.
    _STREAMED_EVENT_TYPES = frozenset(
        {"run.output", "run.output.batch", "run.collaboration"}
    )
    _TERMINAL_EVENT_STATUSES = {
        "run.completed": "completed",
        "run.failed": "failed",
        "run.cancelled": "cancelled",
    }
    # Handler method names by event type. Any other type (``run.completed``,
    # ``run.cancelled``, ``run.failed``, or an unknown one) falls through to
    # ``_handle_run_terminal``, which treats it as a failure like it always has.
    _EVENT_HANDLERS = {
        "run.exit_unconfirmed": "_handle_run_exit_unconfirmed",
        "run.permission_requested": "_handle_run_permission_requested",
        "run.permission_withdrawn": "_handle_run_permission_withdrawn",
        "run.workspace": "_handle_run_workspace",
        "run.executing": "_handle_run_executing",
        "run.output": "_handle_run_output",
        "run.output.batch": "_handle_run_output_batch",
        "run.collaboration": "_handle_run_collaboration",
    }

    def _handle_event_unlocked(
        self, sandbox_id: str, event: dict[str, Any], token: str | None
    ) -> None:
        self._assert_authorized(sandbox_id, token)
        self._mark_seen(sandbox_id)
        record = self.daemon_store.get_command(event["commandId"])
        if not record:
            self._log_no_active_command(sandbox_id, event)
            return
        if event.get("outputTruncated"):
            logger.warning(
                "Run completed but the backend refused part of its streamed output",
                sandbox_id=sandbox_id, command_id=event["commandId"], run_id=event["runId"],
            )
        late_output = (
            event.get("replayed") is True
            and event["type"] in self._STREAMED_EVENT_TYPES
            and record.get("status") in {"completed", "failed", "cancelled"}
        )
        if late_output and (not event.get("leaseId") or event["leaseId"] != record.get("leaseId")):
            raise PermissionError("Replayed output must match the completed command lease.")
        if record.get("status") != "dispatched" and not late_output:
            self._handle_undispatched_command_event(sandbox_id, event, record)
            return
        command = record["command"]
        active = self._active_command_entry(record)
        if not late_output:
            self.active_commands[event["commandId"]] = active
        self._assert_event_matches_active(sandbox_id, event, active)
        handler_name = self._EVENT_HANDLERS.get(event["type"], "_handle_run_terminal")
        getattr(self, handler_name)(sandbox_id, command, event, late_output)

    @staticmethod
    def _log_no_active_command(sandbox_id: str, event: dict[str, Any]) -> None:
        logger.debug(
            "Daemon node event ignored: no active command",
            sandbox_id=sandbox_id,
            command_id=event["commandId"],
        )

    def _handle_undispatched_command_event(
        self, sandbox_id: str, event: dict[str, Any], record: dict[str, Any]
    ) -> None:
        """Settle a replayed terminal event for an already-finished command.

        Anything else aimed at a command that is no longer dispatched is ignored.
        """
        terminal_status = self._TERMINAL_EVENT_STATUSES.get(event["type"])
        command = record["command"]
        replay_matches = (
            record.get("nodeId") == sandbox_id
            and command.get("sessionId") == event.get("sessionId")
            and command.get("runId") == event.get("runId")
            and command.get("agent") == event.get("agent")
            and (
                not record.get("leaseId")
                or not event.get("leaseId")
                or record["leaseId"] == event["leaseId"]
            )
        )
        if not (
            terminal_status
            and record.get("status") == terminal_status
            and replay_matches
        ):
            self._log_no_active_command(sandbox_id, event)
            return
        self.active_commands.pop(event["commandId"], None)
        self.daemon_store.mark_cancel_commands_completed(
            sandbox_id, event["commandId"]
        )
        self._claim_and_advance_run_request(event)

    @staticmethod
    def _active_command_entry(record: dict[str, Any]) -> dict[str, Any]:
        command = record["command"]
        return {
            "sandboxId": record["nodeId"],
            "commandId": command["id"],
            **({"leaseId": record["leaseId"]} if record.get("leaseId") else {}),
            "sessionId": command["sessionId"],
            "runId": command["runId"],
            "agent": command["agent"],
            "taskGoal": command.get("taskGoal", ""),
            **(
                {"workspacePath": command["workspacePath"]}
                if command.get("workspacePath")
                else {}
            ),
            "startedAt": record.get("dispatchedAt", record["createdAt"]),
        }

    @staticmethod
    def _reject_event(sandbox_id: str, event: dict[str, Any], log: str, error: str) -> None:
        logger.warning(
            log,
            sandbox_id=sandbox_id,
            command_id=event["commandId"],
            run_id=event["runId"],
        )
        raise PermissionError(error)

    def _assert_event_matches_active(
        self, sandbox_id: str, event: dict[str, Any], active: dict[str, Any]
    ) -> None:
        if (
            active["sandboxId"] != sandbox_id
            or active["runId"] != event["runId"]
            or active["sessionId"] != event["sessionId"]
        ):
            self._reject_event(
                sandbox_id,
                event,
                "Daemon node event mismatch",
                "Unauthorized daemon node event: command belongs to a different sandbox.",
            )
        if (
            active.get("leaseId")
            and (event.get("leaseId") or event["type"] == "run.executing")
            and active["leaseId"] != event.get("leaseId")
        ):
            self._reject_event(
                sandbox_id,
                event,
                "Daemon node event lease mismatch",
                "Unauthorized daemon node event: command lease does not match the active command.",
            )
        if active["agent"] != event["agent"]:
            self._reject_event(
                sandbox_id,
                event,
                "Daemon node event command metadata mismatch",
                "Unauthorized daemon node event: command metadata does not match the active command.",
            )

    def _handle_run_exit_unconfirmed(
        self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any], late_output: bool
    ) -> None:
        self._record_exit_unconfirmed(sandbox_id, command, event)

    def _handle_run_permission_requested(
        self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any], late_output: bool
    ) -> None:
        if late_output:
            return
        self._record_permission_request(sandbox_id, command, event)
        self._note_run_progress(command)

    def _handle_run_permission_withdrawn(
        self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any], late_output: bool
    ) -> None:
        if late_output:
            return
        self._withdraw_permission_request(sandbox_id, event)

    def _handle_run_workspace(
        self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any], late_output: bool
    ) -> None:
        run_request = self.daemon_store.get_run_request(command.get("_runRequestId"))
        task_id = (run_request or {}).get("taskId")
        if not (task_id and self.task_store):
            return
        waiting = {"runId": event["runId"], "sessionId": event["sessionId"]}
        blocker = event.get("blockingSessionId")
        if blocker and self._blocker_shares_workspace(blocker, event["sessionId"]):
            waiting["blockingSessionId"] = blocker
        self.task_store.append_event(
            task_id,
            relay_task_event(
                "task.workspace_wait",
                task_id,
                {
                    "runId": event["runId"],
                    "waiting": waiting if event["waiting"] else None,
                },
            ),
            execution_owner=request_execution_owner(run_request),
        )

    def _blocker_shares_workspace(self, blocker: str, session_id: str) -> bool:
        try:
            blocking_session = self.store.get_session(blocker)
            current_session = self.store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            blocking_session = None
        if not blocking_session:
            return False
        return all(
            blocking_session.get(key) == current_session.get(key)
            for key in (
                "ownerUserId",
                "computerId",
                "workspaceLayout",
                "workspaceSubpath",
            )
        )

    def _handle_run_executing(
        self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any], late_output: bool
    ) -> None:
        run_request = self.daemon_store.get_run_request(command.get("_runRequestId"))
        if run_request:
            self._ensure_agent_started_for_command(run_request, command)
        self._record_handoff_delivery(command, "running")
        self._record_skipped_skills(command, event.get("skillsSkipped"))
        if not late_output:
            self._note_run_progress(command)

    def _handle_run_output(
        self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any], late_output: bool
    ) -> None:
        seen = self._output_sequences_for_run(event["sessionId"], event["runId"])
        if event["sequence"] <= seen.get(event["stream"], -1):
            return
        self.store.append_event(
            event["sessionId"],
            relay_event(
                "agent.output",
                event["sessionId"],
                {
                    "runId": event["runId"],
                    "agent": event["agent"],
                    "stream": event["stream"],
                    "text": event["text"],
                    "sequence": event["sequence"],
                },
            ),
            hydrate_events=False,
        )
        seen[event["stream"]] = event["sequence"]
        self._append_run_output(event["runId"], event["text"])
        if not late_output:
            self._note_run_progress(command)

    def _handle_run_output_batch(
        self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any], late_output: bool
    ) -> None:
        seen = self._output_sequences_for_run(event["sessionId"], event["runId"])
        candidate_seen = dict(seen)
        accepted_entries: list[dict[str, Any]] = []
        for entry in event["entries"]:
            stream = entry["stream"]
            if entry["sequence"] <= candidate_seen.get(stream, -1):
                continue
            accepted_entries.append(entry)
            candidate_seen[stream] = entry["sequence"]
        if not accepted_entries:
            return
        self.store.append_event(
            event["sessionId"],
            relay_event(
                "agent.output.batch",
                event["sessionId"],
                {
                    "runId": event["runId"],
                    "agent": event["agent"],
                    "entries": accepted_entries,
                },
            ),
            hydrate_events=False,
        )
        seen.update(candidate_seen)
        for entry in accepted_entries:
            self._append_run_output(event["runId"], entry["text"])
        if not late_output:
            self._note_run_progress(command)

    def _handle_run_collaboration(
        self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any], late_output: bool
    ) -> None:
        seen = self._output_sequences_for_run(event["sessionId"], event["runId"])
        if event["sequence"] <= seen.get("collaboration", -1):
            return
        self.store.append_event(
            event["sessionId"],
            relay_event(
                "agent.collaboration",
                event["sessionId"],
                {
                    "runId": event["runId"],
                    "agent": event["agent"],
                    "sequence": event["sequence"],
                    "collaboration": event["collaboration"],
                    "collaborationScope": "assignment",
                    **(
                        {"assignmentId": command["assignmentId"]}
                        if command.get("assignmentId")
                        else {}
                    ),
                    **(
                        {"logicalAgentId": command["logicalAgentId"]}
                        if command.get("logicalAgentId")
                        else {}
                    ),
                },
            ),
            hydrate_events=False,
        )
        seen["collaboration"] = event["sequence"]
        if not late_output:
            self._note_run_progress(command)

    def _handle_run_terminal(
        self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any], late_output: bool
    ) -> None:
        if not self._mark_command_terminal(sandbox_id, event):
            logger.debug(
                "Daemon node terminal event ignored: delivery is no longer active",
                sandbox_id=sandbox_id,
                command_id=event["commandId"],
            )
            return
        self.active_commands.pop(event["commandId"], None)
        self.daemon_store.mark_cancel_commands_completed(sandbox_id, event["commandId"])
        if not self._claim_and_advance_run_request(event):
            self.clear_run_output(event["runId"])

    def _mark_command_terminal(self, sandbox_id: str, event: dict[str, Any]) -> bool:
        """Log and persist a terminal event; any non-completed/cancelled type fails."""
        fields = {
            "sandbox_id": sandbox_id,
            "command_id": event["commandId"],
            "run_id": event["runId"],
            "agent": event["agent"],
        }
        if event["type"] == "run.completed":
            logger.info(
                "Agent run completed on daemon node",
                **fields,
                exit_code=event.get("exitCode"),
            )
            return self.daemon_store.mark_command_completed(sandbox_id, event)
        if event["type"] == "run.cancelled":
            logger.info("Agent run cancelled on daemon node", **fields)
            return self.daemon_store.mark_command_cancelled(sandbox_id, event)
        logger.warning(
            "Agent run failed on daemon node", **fields, error=event.get("error")
        )
        return self.daemon_store.mark_command_failed(sandbox_id, event)

    def _note_run_progress(self, command: dict[str, Any]) -> None:
        """Record that the command's run is still doing something.

        Streaming output is the only signal a long agent turn gives between
        dispatch and its terminal event. Without it the reaper judges every run
        by its dispatch time and cancels work that is plainly alive.
        """
        request_id = command.get("_runRequestId")
        if not isinstance(request_id, str) or not request_id:
            return
        now = time.monotonic()
        last = self._last_progress_persisted_at.get(request_id)
        if (
            last is not None
            and now - last < config.DAEMON_RUN_PROGRESS_PERSIST_INTERVAL_SECONDS
        ):
            return
        request = self.daemon_store.get_run_request(request_id)
        # Only the run this command belongs to may extend its own deadline; a
        # late chunk from a superseded command must not revive the request.
        if not request or request.get("currentCommandId") != command["id"]:
            self._last_progress_persisted_at.pop(request_id, None)
            return
        if request.get("status") not in ACTIVE_RUN_REQUEST_STATUSES:
            self._last_progress_persisted_at.pop(request_id, None)
            return
        self._last_progress_persisted_at[request_id] = now
        self.daemon_store.update_run_request(
            request_id, {"currentProgressAt": now_iso()}
        )

    def output_for_run(self, run_id: str) -> str:
        return "".join(self.outputs.get(run_id, []))

    def _append_run_output(self, run_id: str, text: str) -> None:
        if config.RUN_OUTPUT_BUFFER_MAX_CHARS <= 0:
            return
        chunks = self.outputs.setdefault(run_id, [])
        chunks.append(text[-config.RUN_OUTPUT_BUFFER_MAX_CHARS:])
        size = self.output_sizes.get(run_id, 0) + len(chunks[-1])
        while size > config.RUN_OUTPUT_BUFFER_MAX_CHARS and chunks:
            overflow = size - config.RUN_OUTPUT_BUFFER_MAX_CHARS
            if len(chunks[0]) <= overflow:
                size -= len(chunks.pop(0))
            else:
                chunks[0] = chunks[0][overflow:]
                size -= overflow
        self.output_sizes[run_id] = size

    def clear_run_output(self, run_id: str) -> None:
        self.outputs.pop(run_id, None)
        self.output_sizes.pop(run_id, None)
        self.output_sequences.pop(run_id, None)
        self.output_sequences_hydrated.discard(run_id)

    def _output_sequences_for_run(self, session_id: str, run_id: str) -> dict[str, int]:
        seen = self.output_sequences.setdefault(run_id, {})
        if run_id not in self.output_sequences_hydrated:
            for stream, sequence in self._session_output_sequences(
                session_id, run_id
            ).items():
                seen[stream] = max(seen.get(stream, -1), sequence)
            self.output_sequences_hydrated.add(run_id)
        return seen

    def _session_output_sequences(self, session_id: str, run_id: str) -> dict[str, int]:
        try:
            session = self.store.get_session(session_id)
        except KeyError:
            logger.warning(
                "Failed to read session when checking output sequence",
                session_id=session_id,
                run_id=run_id,
            )
            return {}
        seen: dict[str, int] = {}
        for event in session.get("events", []):
            if (
                event.get("type") == "agent.output.batch"
                and event.get("runId") == run_id
            ):
                for entry in event.get("entries", []):
                    stream = entry.get("stream") if isinstance(entry, dict) else None
                    sequence = (
                        entry.get("sequence") if isinstance(entry, dict) else None
                    )
                    if isinstance(stream, str) and isinstance(sequence, int):
                        seen[stream] = max(seen.get(stream, -1), sequence)
                continue
            if (
                event.get("type") not in ("agent.output", "agent.collaboration")
                or event.get("runId") != run_id
                or not isinstance(event.get("sequence"), int)
            ):
                continue
            stream = (
                event.get("stream")
                if event.get("type") == "agent.output"
                else "collaboration"
            )
            if not isinstance(stream, str):
                continue
            seen[stream] = max(seen.get(stream, -1), event["sequence"])
        return seen
