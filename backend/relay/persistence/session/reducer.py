"""The session event reducer: replaying events into a session snapshot."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ...core.permission_requests import (
    apply_permission_requested,
    apply_permission_resolved,
    expire_permission_requests,
)
from ...core.token_usage import merge_token_usage

SESSION_WORKSPACE_LAYOUT_THREAD = "thread"


def materialize_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    created = next(
        (event for event in events if event.get("type") == "session.created"), None
    )
    if not created:
        raise ValueError("Relay session event log is missing session.created.")
    session: dict[str, Any] = {
        "id": created["sessionId"],
        "workspacePath": created["workspacePath"],
        "taskGoal": created["taskGoal"],
        "participants": created.get("participants", ["human"]),
        "status": "running",
        "phase": "created",
        "createdAt": created["timestamp"],
        "updatedAt": created["timestamp"],
        "agentRuns": [],
        "artifacts": [],
        "decisions": [],
        "collaborationRounds": [],
        "collaborationRevision": 0,
        "events": [],
        "archived": False,
    }
    if created.get("workspaceLayout"):
        session["workspaceLayout"] = created["workspaceLayout"]
    if created.get("ownerUserId"):
        session["ownerUserId"] = created["ownerUserId"]
    if created.get("ownerAgentId"):
        session["ownerAgentId"] = created["ownerAgentId"]
        # The room starts as whoever the thread started with; `@` mentions grow
        # it from there. A team thread seeds the rest of its roster from the
        # team snapshot at dispatch time, so legacy threads replay correctly.
        session["participantAgentIds"] = [created["ownerAgentId"]]
    else:
        session["participantAgentIds"] = []
    if created.get("teamId"):
        session["teamId"] = created["teamId"]
    if created.get("projectId"):
        session["projectId"] = created["projectId"]
    if created.get("workspaceSubpath"):
        session["workspaceSubpath"] = created["workspaceSubpath"]
    if created.get("daemonNodeId"):
        session["daemonNodeId"] = created["daemonNodeId"]
    if created.get("managedNodeId"):
        session["managedNodeId"] = created["managedNodeId"]
    if created.get("computerId"):
        session["computerId"] = created["computerId"]
    for event in events:
        apply_session_event(session, event)
    return session


def apply_session_event(
    session: dict[str, Any], event: dict[str, Any], *, retain_event: bool = True
) -> dict[str, Any]:
    """Incrementally update a derived session projection with one event."""
    if retain_event:
        session.setdefault("events", []).append(event)
    session["updatedAt"] = event["timestamp"]
    handler = SESSION_EVENT_HANDLERS.get(event.get("type", ""))
    if handler:
        handler(session, event)
    return session


# What a thread waiting on its human asked: the question, the answers it
# offered, and any acceptance-gate reasons the question stood in front of.
INPUT_REQUEST_FIELDS = ("inputQuestion", "inputOptions", "inputNotes")
# Follow-up requests the finished turn suggested; any new activity retires them.
NEXT_STEPS_FIELD = "nextSteps"


def _apply_session_status(session: dict[str, Any], event: dict[str, Any]) -> None:
    session["status"] = event["status"]
    session["phase"] = event["phase"]
    if event.get("pendingDecision"):
        session["pendingDecision"] = event["pendingDecision"]
    else:
        session.pop("pendingDecision", None)
    if event["status"] not in ("completed", "failed"):
        session.pop("finalOutcome", None)
        session.pop("workOutcome", None)
        session.pop(NEXT_STEPS_FIELD, None)
        # A reject parks the thread for feedback on the turn; the question that
        # turn asked is still what its task waits on, so it stays quoted.
        if event.get("pendingDecision") != "feedback":
            for field in INPUT_REQUEST_FIELDS:
                session.pop(field, None)


def _apply_collaboration_round_started(
    session: dict[str, Any], event: dict[str, Any]
) -> None:
    manifest = event.get("manifest")
    if not isinstance(manifest, dict):
        return
    rounds = session.get("collaborationRounds") or []
    round_id = manifest.get("roundId")
    if not any(item.get("roundId") == round_id for item in rounds):
        rounds = [*rounds, manifest]
    session["collaborationRounds"] = rounds
    session["collaborationRevision"] = len(rounds)
    if isinstance(manifest.get("collaborationId"), str):
        session["activeCollaborationId"] = manifest["collaborationId"]
    if isinstance(round_id, str):
        session["activeRoundId"] = round_id


def _apply_agent_started(session: dict[str, Any], event: dict[str, Any]) -> None:
    if any(run["id"] == event["runId"] for run in session["agentRuns"]):
        return
    session.pop("workOutcome", None)
    session.pop(NEXT_STEPS_FIELD, None)
    for field in INPUT_REQUEST_FIELDS:
        session.pop(field, None)
    if event.get("daemonNodeId"):
        session["daemonNodeId"] = event["daemonNodeId"]
    if event.get("managedNodeId") and not session.get("managedNodeId"):
        session["managedNodeId"] = event["managedNodeId"]
    run = {
        "id": event["runId"],
        "agent": event["agent"],
        "status": "running",
        "startedAt": event["timestamp"],
        "artifactIds": [],
    }
    for key in (
        "role",
        "logicalAgentId",
        "placementId",
        "daemonNodeId",
        "agentVersion",
        "workspaceIdentity",
        "brief",
        "coordinator",
        "synthesizer",
        "consultation",
        "teamSnapshot",
        "assignmentId",
        "workItemId",
        "delegationAuthority",
        "dependsOnWorkItemIds",
        "workKind",
        "teamPhase",
        "followUp",
    ):
        if event.get(key) is not None:
            run[key] = event[key]
    session["status"] = "running"
    session["phase"] = event["agent"]
    session["currentAgent"] = event["agent"]
    session["agentRuns"] = [*session["agentRuns"], run]


def _apply_agent_completed(session: dict[str, Any], event: dict[str, Any]) -> None:
    session["agentRuns"] = [
        _completed_run(run, event) if run["id"] == event["runId"] else run
        for run in session["agentRuns"]
    ]
    token_usage = merge_token_usage(
        [run.get("tokenUsage") for run in session["agentRuns"]]
    )
    if token_usage:
        session["tokenUsage"] = token_usage
    else:
        session.pop("tokenUsage", None)
    session.pop("currentAgent", None)
    # The run that asked is gone, so nothing is left to answer its prompts.
    expire_permission_requests(session, event["timestamp"], run_id=event["runId"])
    if event["status"] == "completed":
        session["phase"] = "agent_completed"
    elif event["status"] == "cancelled":
        session["phase"] = "cancelled"
    else:
        session["phase"] = "agent_failed"


def _completed_run(run: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    completed = {
        **run,
        "status": event["status"],
        "completedAt": event["timestamp"],
        "exitCode": event["exitCode"],
    }
    if "agentLog" in event:
        completed["agentLog"] = event["agentLog"]
    for key in ("workResult", "tokenUsage", "runtimeSessionId"):
        if event.get(key):
            completed[key] = event[key]
    if event.get("outputTruncated"):
        completed["outputTruncated"] = True
    return completed


def _apply_artifact_created(session: dict[str, Any], event: dict[str, Any]) -> None:
    artifact = event["artifact"]
    session["artifacts"] = [*session["artifacts"], artifact]
    if not artifact.get("agentRunId"):
        return
    session["agentRuns"] = [
        {**run, "artifactIds": [*(run.get("artifactIds") or []), artifact["id"]]}
        if run["id"] == artifact["agentRunId"]
        else run
        for run in session["agentRuns"]
    ]


def _apply_human_decision(session: dict[str, Any], event: dict[str, Any]) -> None:
    decision = event["decision"]
    session["decisions"] = [*session["decisions"], decision]
    if decision["kind"] == "handoff" and decision.get("targetAgent"):
        session["currentAgent"] = decision["targetAgent"]
    if decision["kind"] == "cancel":
        session["status"] = "cancelled"
        session["phase"] = "cancelled"
        session.pop("workOutcome", None)
        for field in INPUT_REQUEST_FIELDS:
            session.pop(field, None)
        session.pop("pendingDecision", None)
        expire_permission_requests(session, event["timestamp"])


def _apply_session_terminal(session: dict[str, Any], event: dict[str, Any]) -> None:
    status = "completed" if event["type"] == "session.completed" else "failed"
    session["status"] = status
    session["phase"] = status
    session["finalOutcome"] = event["outcome"]
    session["workOutcome"] = (
        event.get("workOutcome", "unverified") if status == "completed" else "blocked"
    )
    for field in INPUT_REQUEST_FIELDS:
        value = event.get(field) if status == "completed" else None
        if value:
            session[field] = list(value) if isinstance(value, list) else value
        else:
            session.pop(field, None)
    next_steps = event.get(NEXT_STEPS_FIELD) if status == "completed" else None
    if isinstance(next_steps, list) and next_steps:
        session[NEXT_STEPS_FIELD] = list(next_steps)
    else:
        session.pop(NEXT_STEPS_FIELD, None)
    session.pop("currentAgent", None)
    session.pop("pendingDecision", None)
    expire_permission_requests(session, event["timestamp"])


def _apply_session_archived(session: dict[str, Any], _event: dict[str, Any]) -> None:
    session["archived"] = True


def _apply_session_runtime_affinity(
    session: dict[str, Any], event: dict[str, Any]
) -> None:
    """A thread pins one Computer once; first write wins, later ones do not
    overwrite it.

    Older events carry only `managedNodeId`, derived here as `managed:<id>`,
    so no Alembic backfill is needed — the snapshot is a product of replay.
    """
    if session.get("computerId"):
        return
    identity = event.get("computerId")
    if not identity and event.get("managedNodeId"):
        identity = f"managed:{event['managedNodeId']}"
    if not identity:
        return
    session["computerId"] = identity
    if identity.startswith("managed:") and not session.get("managedNodeId"):
        session["managedNodeId"] = identity.split(":", 1)[1]


def _apply_session_renamed(session: dict[str, Any], event: dict[str, Any]) -> None:
    session["title"] = event["title"]


def _apply_deletion_requested(session: dict[str, Any], event: dict[str, Any]) -> None:
    session.setdefault("deletionRequestedAt", event["timestamp"])
    session.setdefault("deletionRequestedBy", event["requestedBy"])


def _apply_participants_joined(session: dict[str, Any], event: dict[str, Any]) -> None:
    """Grow the thread's room. Membership only ever grows, never shrinks."""
    roster = list(session.get("participantAgentIds") or [])
    for agent_id in event.get("agentIds") or []:
        if isinstance(agent_id, str) and agent_id and agent_id not in roster:
            roster.append(agent_id)
    session["participantAgentIds"] = roster


SessionEventHandler = Callable[[dict[str, Any], dict[str, Any]], None]
SESSION_EVENT_HANDLERS: dict[str, SessionEventHandler] = {
    "session.status": _apply_session_status,
    "collaboration.round.started": _apply_collaboration_round_started,
    "agent.started": _apply_agent_started,
    "agent.completed": _apply_agent_completed,
    "artifact.created": _apply_artifact_created,
    "human.decision": _apply_human_decision,
    "session.completed": _apply_session_terminal,
    "session.failed": _apply_session_terminal,
    "session.archived": _apply_session_archived,
    "session.runtime_affinity": _apply_session_runtime_affinity,
    "session.renamed": _apply_session_renamed,
    "session.deletion_requested": _apply_deletion_requested,
    "thread.participants_joined": _apply_participants_joined,
    "agent.permission_requested": apply_permission_requested,
    "agent.permission_resolved": apply_permission_resolved,
}

# Streamed run output has no reducer: it changes nothing in the projection, so
# the database store appends it without reading or rewriting the snapshot (the
# snapshot carries every run and artifact, and rewriting it per chunk was the
# hottest write in the system). Such an event deliberately does not bump the
# session's updatedAt; the run's agent.started/agent.completed already do.
SNAPSHOT_NEUTRAL_SESSION_EVENTS = frozenset(
    {"agent.output", "agent.output.batch", "agent.collaboration"}
)
