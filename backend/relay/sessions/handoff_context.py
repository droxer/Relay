"""Capture bounded, immutable recovery context in durable event order.

The manifest stores references plus excerpts, never complete transcripts. It is
captured before admission and then travels with the prepared round on retries.
"""

from __future__ import annotations

from typing import Any

from .bridge import (
    ArtifactReader,
    agent_log_for_run,
    include_run_in_continuity,
    run_continuity_text,
)

CONTEXT_BUDGET = 24000
_ELISION = "\n[Context omitted; consult referenced run logs and the progress file.]\n"


def _clip(text: str, limit: int, *, tail: bool = False) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    available = max(0, limit - len(_ELISION))
    excerpt = (text[-available:] if tail else text[:available]) if available else ""
    return (_ELISION + excerpt if tail else excerpt + _ELISION), True


def capture_handoff_context(
    session: dict[str, Any],
    assignment: dict[str, Any],
    note: str | None,
    store: ArtifactReader,
) -> dict[str, Any]:
    events = session.get("events") or []
    objective = session.get("taskGoal") or ""
    for event in events:
        if event.get("type") == "user.message":
            objective = event.get("text") or ""
    objective, goal_cut = _clip(objective, 6000)
    instruction, note_cut = _clip((note or "").strip(), 4000)
    runs = {
        r["id"]: r for r in session.get("agentRuns", []) if include_run_in_continuity(r)
    }
    blocks: list[str] = []
    run_ids: list[str] = []
    artifact_ids: list[str] = []
    missing: list[str] = []
    latest_report: str | None = None

    def add_run(run_id: str) -> None:
        nonlocal latest_report
        if run_id in run_ids or run_id not in runs:
            return
        run = runs[run_id]
        run_ids.append(run_id)
        artifact_ids.extend(run.get("artifactIds") or [])
        body = run_continuity_text(run, agent_log_for_run(session, run, store))
        if not body:
            missing.append(run_id)
        identity = run.get("logicalAgentId") or run.get("agent") or "agent"
        latest_report = f"[Agent report @{identity}; executor={run.get('agent')}; run={run_id}; {run.get('status') or 'completed'}]\n{body or '<no output>'}"
        blocks.append(latest_report)

    if session.get("taskGoal"):
        blocks.append(f"[Original user objective]\n{session['taskGoal']}")
    # Legacy snapshots may carry terminal runs without their completion event.
    completed_ids = {
        e.get("runId") for e in events if e.get("type") == "agent.completed"
    }
    for run_id in runs:
        if run_id not in completed_ids:
            add_run(run_id)
    latest_user_index = max(
        (i for i, e in enumerate(events) if e.get("type") == "user.message"), default=-1
    )
    for index, event in enumerate(events):
        if event.get("type") == "user.message" and index != latest_user_index:
            blocks.append(f"[User]\n{event.get('text') or ''}")
        elif event.get("type") == "agent.completed":
            add_run(event.get("runId"))
        elif event.get("type") == "human.decision":
            decision = event.get("decision") or {}
            if decision.get("kind") == "handoff" and decision.get("note"):
                target = (
                    decision.get("targetAgentId")
                    or decision.get("targetAgent")
                    or "agent"
                )
                blocks.append(f"[Historical handoff to @{target}]\n{decision['note']}")
    # Reserve the fixed active-instruction heading added at dispatch too.
    budget = CONTEXT_BUDGET - len(objective) - len(instruction) - 64
    # Reserve space for the latest result even if later notes fill history.
    report_cut = False
    reserved_report = ""
    if latest_report:
        blocks.remove(latest_report)
        header, _, body = latest_report.partition("\n")
        body, report_cut = _clip(body, 5000 - len(header[:256]) - 1, tail=True)
        reserved_report = header[:256] + "\n" + body
        budget -= len(reserved_report) + 2
    # Preserve attribution when truncating historical blocks.
    kept: list[str] = []
    used = 0
    history_cut = False
    for block in reversed(blocks):
        remaining = budget - used - 2
        if len(kept) >= 24 or remaining <= len(_ELISION) + 256:
            history_cut = True
            break
        if len(block) > remaining:
            header, _, body = block.partition("\n")
            header = header[:256]
            body, _ = _clip(body, remaining - len(header) - 1, tail=True)
            kept.append(header + "\n" + body)
            history_cut = True
            break
        kept.append(block)
        used += len(block) + 2
    prior = "\n\n".join(reversed(kept))
    # Keep omission visible even when whole earlier blocks were dropped.
    if history_cut and _ELISION.strip() not in prior:
        prior, _ = _clip(_ELISION + prior, budget)
    if reserved_report:
        prior = "\n\n".join(filter(None, [prior, reserved_report]))
    layout = session.get("workspaceLayout") or "node-root"
    return {
        "contract": {"name": "relay.handoff.context", "version": 1},
        "assignmentId": assignment["assignmentId"],
        "targetAgentId": assignment.get("agentId"),
        "targetExecutor": assignment.get("executorKind") or assignment.get("agent"),
        "targetDisplayName": assignment.get("agentDisplayName")
        or assignment.get("agentId"),
        "sourceEventCount": len(events),
        "sourceEventId": events[-1].get("id") if events else None,
        "sourceRunId": run_ids[-1] if run_ids else None,
        "sourceAssignmentId": runs[run_ids[-1]].get("assignmentId")
        if run_ids
        else None,
        "computerId": session.get("computerId"),
        "workspaceLayout": layout,
        "workspaceSubpath": session.get("workspaceSubpath"),
        "progressFile": "PROGRESS.md"
        if layout == "thread"
        else f"PROGRESS-{session['id']}.md",
        "objective": objective,
        "note": instruction,
        "priorContext": prior,
        "runIds": run_ids[-24:],
        "artifactIds": list(dict.fromkeys(artifact_ids))[-48:],
        "missingRunIds": missing[-24:],
        "truncated": goal_cut
        or note_cut
        or report_cut
        or history_cut
        or len(run_ids) > 24
        or len(artifact_ids) > 48,
    }
