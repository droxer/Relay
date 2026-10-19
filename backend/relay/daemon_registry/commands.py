"""The per-node command queue: enqueue, poll, leases, heartbeats, and active-command tracking.

A mixin of ``DaemonNodeRegistry``: it shares the registry's state and locks
(declared on ``RegistryState``) and is not used on its own.
"""

from __future__ import annotations

from typing import Any
from loguru import logger
from ..core.permission_requests import (
    permission_request_node,
    permission_request_status,
)
from ..core.ids import now_iso
from ..persistence.daemon.rules import EXIT_UNCONFIRMED_STATE_KEY
from ..persistence.stores import (
    relay_event,
)
from ..core.daemon_capabilities import (
    DAEMON_CAPABILITY_PROJECT_LINKS,
    DAEMON_CAPABILITY_PROJECT_WORKSPACE_DELETE,
    has_capability,
)
from ..services.workspace_capabilities import required_workspace_capabilities
from . import config
from .records import (
    daemon_command_payload,
)
from .state import RegistryState


TERMINAL_STATUSES = ("completed", "failed", "cancelled")
WORKSPACE_BROWSE_COMMANDS = ("workspace.link", "workspace.list", "workspace.read")
SUPPRESSIBLE_RUN_REQUEST_STATUSES = ("prepared", "running", "dispatching")
SUPPRESSED_RUN_REASON = (
    "Run delivery suppressed because its request or session is terminal."
)


def missing_workspace_capability(
    command: dict[str, Any], sandbox: dict[str, Any] | None
) -> str | None:
    """The first capability `command` needs that the node does not advertise."""
    required_capabilities = (
        (DAEMON_CAPABILITY_PROJECT_LINKS,)
        if command.get("type") == "workspace.link"
        else required_workspace_capabilities(
            command.get("workspaceLayout"), command.get("workspaceSubpath")
        )
    )
    return next(
        (
            capability for capability in required_capabilities
            if not has_capability(sandbox, capability)
        ),
        None,
    )


HEARTBEAT_FEATURES = ("poll-liveness", "state")
HEARTBEAT_STATES = ("ready", "draining", "stopped")


def run_request_is_live(
    run_request: dict[str, Any] | None, command: dict[str, Any]
) -> bool:
    return bool(
        run_request
        and run_request.get("status") == "running"
        and run_request.get("currentCommandId") == command.get("id")
    )


def session_is_live(session: dict[str, Any] | None) -> bool:
    return bool(session and session.get("status") not in TERMINAL_STATUSES)


def suppressed_run_request_status(session: dict[str, Any] | None) -> str:
    """A suppressed run's request takes its session's terminal status, else cancelled."""
    if session and session.get("status") in TERMINAL_STATUSES:
        return session["status"]
    return "cancelled"


def delivered_run_entry(sandbox_id: str, record: dict[str, Any]) -> dict[str, Any]:
    """The active-command entry for a run.start record just leased to a daemon."""
    command = record["command"]
    return {
        "sandboxId": sandbox_id,
        "commandId": command["id"],
        **({"leaseId": record["leaseId"]} if record.get("leaseId") else {}),
        "sessionId": command["sessionId"],
        "runId": command["runId"],
        "agent": command["agent"],
        "taskGoal": command["taskGoal"],
        **(
            {"workspacePath": command["workspacePath"]}
            if command.get("workspacePath")
            else {}
        ),
        "startedAt": record.get("dispatchedAt", now_iso()),
    }



class CommandQueueMixin(RegistryState):
    def enqueue(self, sandbox_id: str, command: dict[str, Any]) -> None:
        with self.dispatch_scope([sandbox_id]):
            self._enqueue_unlocked(sandbox_id, command)

    def _enqueue_unlocked(self, sandbox_id: str, command: dict[str, Any]) -> None:
        self.daemon_store.enqueue_command(sandbox_id, command)
        logger.debug(
            "Command enqueued",
            sandbox_id=sandbox_id,
            command_id=command["id"],
            command_type=command["type"],
        )
        self._track_active_command(sandbox_id, command)

    def _record_permission_request(
        self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any]
    ) -> None:
        """Put a live run's permission prompt in front of its thread's person."""
        request = {
            **event["request"],
            "runId": event["runId"],
            "agent": event["agent"],
            "daemonNodeId": sandbox_id,
            **(
                {"logicalAgentId": command["logicalAgentId"]}
                if command.get("logicalAgentId")
                else {}
            ),
        }
        logger.info(
            "Run asked for permission",
            session_id=event["sessionId"],
            run_id=event["runId"],
            request_id=request["id"],
            tool=request["toolName"],
        )
        self.store.append_event(
            event["sessionId"],
            relay_event(
                "agent.permission_requested", event["sessionId"], {"request": request}
            ),
        )

    def permission_request_status(
        self, sandbox_id: str, token: str | None, session_id: str, request_id: str
    ) -> dict[str, Any] | None:
        """The answer a daemon polls for, or None when the prompt is not its own."""
        self._hydrate_node(sandbox_id)
        self._assert_authorized(sandbox_id, token)
        self._mark_seen(sandbox_id)
        try:
            session = self.store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            return None
        if permission_request_node(session, request_id) != sandbox_id:
            return None
        return permission_request_status(session, request_id)

    def _record_handoff_delivery(self, command: dict[str, Any], status: str) -> None:
        if not command.get("reportExecutionStarted"):
            return
        delivery = command.get("delivery") or {}
        if not delivery.get("roundId"):
            return
        session_id = command["sessionId"]
        event_id = f"delivery_{command['runId']}_{status}"
        session = self.store.get_session(session_id)
        if any(event.get("id") == event_id for event in session.get("events", [])):
            return
        event = relay_event(
            "collaboration.delivery",
            session_id,
            {
                "roundId": delivery["roundId"],
                "assignmentId": command["assignmentId"],
                "runId": command["runId"],
                "status": status,
            },
        )
        event["id"] = event_id
        self.store.append_event(session_id, event)

    def _record_skipped_skills(
        self, command: dict[str, Any], daemon_skips: Any
    ) -> None:
        allowed = {
            (skill.get("skillId"), skill.get("slug"))
            for skill in (command.get("skills") or {}).get("skills", [])
            if isinstance(skill, dict)
        }
        accepted: dict[tuple[Any, Any], dict[str, Any]] = {}
        slugs_by_id = dict(allowed)
        for item in daemon_skips if isinstance(daemon_skips, list) else []:
            if not isinstance(item, dict):
                continue
            key = (item.get("skillId"), item.get("slug", slugs_by_id.get(item.get("skillId"))))
            if key not in allowed:
                continue
            accepted.setdefault(key,
                {"skillId": key[0], "slug": key[1], "reason": item.get("reason")}
            )
        combined = [*(command.get("_skillsSkipped") or []), *accepted.values()]
        unique = {
            (item.get("skillId"), item.get("slug"), item.get("reason")): item
            for item in combined
            if isinstance(item, dict)
        }
        skipped = sorted(
            unique.values(),
            key=lambda item: (
                item.get("slug") or "",
                item.get("skillId") or "",
                item.get("reason") or "",
            ),
        )
        if not skipped:
            return
        event_id = f"skills_skipped_{command['runId']}"
        session = self.store.get_session(command["sessionId"])
        if any(event.get("id") == event_id for event in session.get("events", [])):
            return
        names = ", ".join(
            f"{item.get('slug') or item['skillId']} ({item['reason']})"
            for item in skipped
        )
        notice = relay_event(
            "system.notice",
            command["sessionId"],
            {
                "runId": command["runId"],
                "agent": command["agent"],
                "text": f"Some granted skills were unavailable: {names}.",
                "reason": "skills-skipped",
                "skillsSkipped": skipped,
            },
        )
        notice["id"] = event_id
        self.store.append_event(command["sessionId"], notice)

    def _track_active_command(self, sandbox_id: str, command: dict[str, Any]) -> None:
        self._record_handoff_delivery(command, "queued")
        if command.get("_skillsSkipped") and "skills" not in command:
            self._record_skipped_skills(command, [])
        if command["type"] == "run.start":
            self.active_commands[command["id"]] = {
                "sandboxId": sandbox_id,
                "commandId": command["id"],
                "sessionId": command["sessionId"],
                "runId": command["runId"],
                "agent": command["agent"],
                "taskGoal": command["taskGoal"],
                **(
                    {"workspacePath": command["workspacePath"]}
                    if command.get("workspacePath")
                    else {}
                ),
                "startedAt": now_iso(),
            }

    def take_commands(
        self,
        sandbox_id: str,
        token: str | None,
        *,
        limit: int = 2**53,
        lease_seconds: float = config.DAEMON_COMMAND_LEASE_SECONDS,
        renew_known_active: bool = True,
    ) -> list[dict[str, Any]]:
        # Global recovery runs before the node scope so command polling never
        # inverts the terminal-event lock order (global -> node).
        self.reap_stale_runs(force=False)
        self._hydrate_node(sandbox_id)
        with self.dispatch_scope([sandbox_id]):
            return self._take_commands_unlocked(
                sandbox_id,
                token,
                limit=limit,
                lease_seconds=lease_seconds,
                renew_known_active=renew_known_active,
            )

    def heartbeat_settings(self) -> dict[str, Any]:
        """Return the server-owned lease policy advertised to every daemon.

        ``features`` tells a daemon what this backend's heartbeat understands:
        ``poll-liveness`` — an in-flight command poll already renews liveness
        and leases, so the daemon may skip beats while one is open;
        ``state`` — the body may carry ``state`` (``draining``/``stopped``).
        An older backend sends no list and the daemon keeps beating as before.
        """
        return {
            "intervalMs": max(
                1, self.liveness_timeout_ms // config.HEARTBEATS_PER_LIVENESS_WINDOW
            ),
            "timeoutMs": self.liveness_timeout_ms,
            "features": list(HEARTBEAT_FEATURES),
        }

    def heartbeat(
        self,
        sandbox_id: str,
        token: str | None,
        command_leases: list[tuple[str, str | None]] | None = None,
        *,
        lease_seconds: float = config.DAEMON_COMMAND_LEASE_SECONDS,
        state: str | None = None,
    ) -> dict[str, Any]:
        """Renew node liveness and any run leases through one explicit seam.

        Command polling and run events still count as observations for older
        daemons, but new daemons no longer depend on either traffic pattern to
        remain live. Both user-device and managed nodes use this contract;
        infrastructure recovery remains a managed-node policy concern.

        ``state`` ``draining`` marks the node as no longer taking work while it
        stays online for its running agents; ``stopped`` is the graceful exit.
        """
        if state is not None and state not in HEARTBEAT_STATES:
            raise ValueError(f"Unknown heartbeat state {state!r}.")
        self._hydrate_node(sandbox_id)
        with self.dispatch_scope([sandbox_id]):
            self._assert_authorized(sandbox_id, token)
            sandbox = self.sandboxes[sandbox_id]
            if sandbox.get("retiredAt"):
                raise PermissionError("Retired daemon node cannot renew its lease.")
            if state == "stopped":
                self.update_status(sandbox_id, {"status": "stopped", "lastError": None})
            else:
                self._mark_seen(sandbox_id, polled=False if state == "draining" else None)
            if command_leases:
                self._renew_command_leases(
                    sandbox_id,
                    command_leases,
                    lease_seconds=lease_seconds,
                )
            return {
                **self.command_lease_observations(sandbox_id, command_leases or []),
                **self.heartbeat_settings(),
            }

    def command_lease_observations(
        self, sandbox_id: str, command_leases: list[tuple[str, str | None]]
    ) -> dict[str, Any]:
        """Read matching ownership evidence after an authenticated renewal/poll.

        `settledCommandIds` names submitted runs Relay already holds a terminal
        outcome for. A daemon still holding one has not reported it, so that
        outcome is a person's assertion; a daemon stuck verifying the exit may
        then let the run go.
        """
        accepted = []
        settled = []
        for command_id, lease_id in command_leases:
            record = self.daemon_store.get_command(command_id)
            if not record or record.get("nodeId") != sandbox_id:
                continue
            if record.get("status") in ("completed", "failed", "cancelled"):
                settled.append(command_id)
            elif (record.get("status") == "dispatched"
                  and record.get("leaseId") == lease_id and record.get("leaseExpiresAt")):
                accepted.append({"commandId": command_id, "leaseId": lease_id, "leaseExpiresAt": record["leaseExpiresAt"]})
        return {"commandLeases": accepted, "settledCommandIds": settled, "observedAt": now_iso()}

    def _record_exit_unconfirmed(
        self, sandbox_id: str, command: dict[str, Any], event: dict[str, Any]
    ) -> None:
        request_id = command.get("_runRequestId")
        if not request_id or not self.daemon_store.mark_run_request_state(
            request_id, EXIT_UNCONFIRMED_STATE_KEY
        ):
            return
        logger.warning(
            "Daemon cannot confirm a stopped run exited; it stays reserved",
            node_id=sandbox_id, command_id=event["commandId"], run_id=event["runId"],
        )

    def _take_commands_unlocked(
        self,
        sandbox_id: str,
        token: str | None,
        *,
        limit: int,
        lease_seconds: float,
        renew_known_active: bool,
    ) -> list[dict[str, Any]]:
        self._assert_authorized(sandbox_id, token)
        self._mark_seen(sandbox_id, polled=True)
        sandbox = self.sandboxes.get(sandbox_id)
        if sandbox and sandbox.get("retiredAt"):
            if renew_known_active:
                self._renew_known_active_command_leases(
                    sandbox_id, lease_seconds=lease_seconds
                )
            return []
        if renew_known_active:
            self._renew_known_active_command_leases(
                sandbox_id, lease_seconds=lease_seconds
            )
        records = self.daemon_store.take_queued_commands(
            sandbox_id, limit=limit, lease_seconds=lease_seconds
        )
        records = [
            record
            for record in records
            if self._screen_queued_command(sandbox_id, sandbox, record)
        ]
        logger.debug(
            "Commands taken by daemon node",
            sandbox_id=sandbox_id,
            command_count=len(records),
        )
        for record in records:
            command = record["command"]
            if command["type"] == "run.start":
                self.active_commands[command["id"]] = delivered_run_entry(
                    sandbox_id, record
                )
        return [daemon_command_payload(record) for record in records]

    def _screen_queued_command(
        self,
        sandbox_id: str,
        sandbox: dict[str, Any] | None,
        record: dict[str, Any],
    ) -> bool:
        """Whether a leased command may go to the daemon; settles it otherwise."""
        command = record["command"]
        missing_capability = missing_workspace_capability(command, sandbox)
        if not self._workspace_command_deliverable(
            sandbox_id, sandbox, command, missing_capability
        ):
            return False
        if command.get("type") != "run.start":
            return True
        return self._run_start_deliverable(sandbox_id, record, missing_capability)

    def _workspace_command_deliverable(
        self,
        sandbox_id: str,
        sandbox: dict[str, Any] | None,
        command: dict[str, Any],
        missing_capability: str | None,
    ) -> bool:
        if command.get("type") in WORKSPACE_BROWSE_COMMANDS and missing_capability:
            self.daemon_store.record_workspace_response(sandbox_id, {
                "type": "workspace.error", "commandId": command["id"],
                "path": command.get("path", ""), "code": "io-error",
                "message": f"This workspace requires {missing_capability} support; upgrade the daemon.",
            })
            return False
        if command.get("type") == "workspace.delete":
            # Local command storage cannot join the project SQL transaction.
            # Never deliver cleanup if that transaction rolled back, including
            # after a process crash between enqueue and database commit.
            if self.project_store is None or self.project_store.get_project(command["sessionId"]):
                self.daemon_store.record_workspace_response(sandbox_id, {
                    "type": "workspace.error", "commandId": command["id"],
                    "path": "", "code": "invalid-path",
                    "message": "Project still exists; cleanup cancelled.",
                })
                return False
            if not has_capability(sandbox or {}, DAEMON_CAPABILITY_PROJECT_WORKSPACE_DELETE):
                # An older daemon cannot execute this command. Keep the
                # durable lease eligible for retry after a runtime upgrade.
                return False
        return True

    def _run_start_deliverable(
        self,
        sandbox_id: str,
        record: dict[str, Any],
        missing_capability: str | None,
    ) -> bool:
        command = record["command"]
        request_id = command.get("_runRequestId")
        run_request = (
            self.daemon_store.get_run_request(request_id) if request_id else None
        )
        if run_request and missing_capability:
            self._fail_run_request(
                run_request,
                f"The {command.get('workspaceLayout')} requires a daemon with "
                f"{missing_capability} support.",
                delivery_never_sent=record.get("attempt") == 1,
            )
            return False
        try:
            session = self.store.get_session(command["sessionId"])
        except KeyError:
            session = None
        if run_request_is_live(run_request, command) and session_is_live(session):
            return True
        self._suppress_run_delivery(sandbox_id, record, run_request, session)
        return False

    def _suppress_run_delivery(
        self,
        sandbox_id: str,
        record: dict[str, Any],
        run_request: dict[str, Any] | None,
        session: dict[str, Any] | None,
    ) -> None:
        command = record["command"]
        reason = SUPPRESSED_RUN_REASON
        self.daemon_store.mark_command_cancelled(
            sandbox_id,
            {
                "type": "run.cancelled",
                "commandId": command["id"],
                "sessionId": command["sessionId"],
                "runId": command["runId"],
                "agent": command["agent"],
                "reason": reason,
                **({"leaseId": record["leaseId"]} if record.get("leaseId") else {}),
            },
        )
        if run_request and run_request.get("status") in SUPPRESSIBLE_RUN_REQUEST_STATUSES:
            self.daemon_store.update_run_request_if_status(
                run_request["id"],
                run_request["status"],
                {"status": suppressed_run_request_status(session), "error": reason},
            )

    def available_command_count(self, sandbox_id: str, token: str | None) -> int:
        self._hydrate_node(sandbox_id)
        self._assert_authorized(sandbox_id, token)
        self._mark_seen(sandbox_id)
        return self.daemon_store.queued_command_count(sandbox_id)

    def renew_active_command_leases(
        self,
        sandbox_id: str,
        token: str | None,
        command_leases: list[tuple[str, str | None]],
        *,
        lease_seconds: float = config.DAEMON_COMMAND_LEASE_SECONDS,
    ) -> None:
        self._hydrate_node(sandbox_id)
        self._assert_authorized(sandbox_id, token)
        self._mark_seen(sandbox_id)
        if not command_leases:
            return
        self._renew_command_leases(
            sandbox_id, command_leases, lease_seconds=lease_seconds
        )

    def _renew_command_leases(
        self,
        sandbox_id: str,
        command_leases: list[tuple[str, str | None]],
        *,
        lease_seconds: float,
    ) -> None:
        # The durable store, not this registry replica's memory, is the source
        # of truth for command ownership. A poll may land on a different
        # backend process from the one that dispatched the command.
        renewable = list(dict(command_leases).items())
        if renewable and hasattr(self.daemon_store, "renew_command_leases"):
            self.daemon_store.renew_command_leases(
                sandbox_id, renewable, lease_seconds=lease_seconds
            )
            # A held lease is the daemon saying the run is still under way.
            # Output is not: an agent can spend twenty minutes in a build or a
            # single slow tool call without printing a line, and judging it by
            # output alone reaps work that is plainly alive.
            for command_id, _lease_id in renewable:
                self._note_command_lease_progress(sandbox_id, command_id)

    def _renew_known_active_command_leases(
        self, sandbox_id: str, *, lease_seconds: float
    ) -> None:
        if not hasattr(self.daemon_store, "renew_command_leases"):
            return
        active_leases = [
            (command["commandId"], None)
            for command in self.active_commands.values()
            if command.get("sandboxId") == sandbox_id
        ]
        if active_leases:
            self.daemon_store.renew_command_leases(
                sandbox_id, active_leases, lease_seconds=lease_seconds
            )

    def _note_command_lease_progress(self, sandbox_id: str, command_id: str) -> None:
        """Treat a renewed command lease as progress on the run it belongs to."""
        record = self.daemon_store.get_command(command_id)
        if not record or record.get("nodeId") != sandbox_id:
            return
        if record.get("status") != "dispatched":
            return
        self._note_run_progress(record["command"])
