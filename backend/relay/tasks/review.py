"""A revision-bound review of recorded work, without generating new claims."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from ..core.workspace_artifacts import artifact_index_item, is_thread_record_artifact
from .requests import TaskRequestError


@contextmanager
def checked_review(ctx: Any, task: dict[str, Any], body: dict[str, Any]) -> Iterator[None]:
    """An optional conditional acceptance, locked until the enclosing commit.

    Legacy PATCH callers remain supported. Review clients send the revision
    they displayed, never a freshly fetched revision at the moment of Accept.
    """
    if "reviewRevision" not in body:
        yield
        return
    revision = body["reviewRevision"]
    if (not isinstance(revision, str) or len(revision) != 64
            or any(char not in "0123456789abcdef" for char in revision)
            or body.get("status") != "done" or set(body) != {"status", "reviewRevision"}):
        raise TaskRequestError(400, "reviewRevision requires a SHA-256 revision and status done only.")
    with ctx.task_store.task_write_scope(task["id"]):
        current = ctx.task_store.get_task(task["id"])
        if task_review(ctx, current, lock=True)["revision"] != revision:
            raise TaskRequestError(409, "task_review_changed")
        yield


def task_review(ctx: Any, task: dict[str, Any], *, lock: bool = False) -> dict[str, Any]:
    """Read only the newest linked thread, never revive an older deleted result.

    Acceptance calls this under the task write scope. Locking the thread row
    keeps late evidence/artifact ingestion serialized with the decision too.
    Header snapshots contain reports and artifacts without loading transcripts.
    """
    session = None
    ids = task.get("linkedSessionIds") or []
    if ids:
        try:
            session = ctx.session_store.get_session_header(ids[-1], for_update=lock)
        except (KeyError, FileNotFoundError):
            pass
    brief = build_review_brief(task, session)
    # Names aid recognition; stable ids in the hashed report retain attribution.
    names: dict[str, str | None] = {}
    for report in brief["reports"]:
        agent_id = report["agentId"]
        if agent_id and agent_id not in names:
            agent = ctx.agent_store.get_agent(agent_id)
            names[agent_id] = (agent or {}).get("displayName")
        report["agentName"] = names.get(agent_id)
    return brief


def build_review_brief(task: dict[str, Any], session: dict[str, Any] | None) -> dict[str, Any]:
    source = session or {}
    rounds = source.get("collaborationRounds") or []
    manifest = next((item for item in reversed(rounds)
                     if item.get("workScope") == {"kind": "task", "taskId": task["id"]}), None)
    # A modern thread may contain unrelated discussions. Legacy threads have
    # no manifest: show their recorded runs, with no invented round attribution.
    assignments = {item["assignmentId"] for item in (manifest or {}).get("assignments", [])}
    runs = [run for run in source.get("agentRuns", [])
            if run.get("assignmentId") in assignments or not rounds]
    latest: dict[str, dict[str, Any]] = {}
    for run in runs:
        latest[run.get("assignmentId") or run["id"]] = run
    reports = [_report(run) for run in latest.values()]
    run_ids = {run["id"] for run in runs}
    artifacts = [artifact_index_item(source, item) for item in source.get("artifacts", [])
                 if (item.get("agentRunId") in run_ids or not rounds)
                 and not is_thread_record_artifact(source, item)]
    criteria = list(dict.fromkeys(
        text for item in (manifest or {}).get("workGraph", {}).get("items", [])
        for text in item.get("acceptanceCriteria", [])
    ))
    brief = {
        "taskId": task["id"], "status": task["status"],
        "goal": task["title"], "description": task.get("description") or "",
        "sessionId": source.get("id"), "roundId": (manifest or {}).get("roundId"),
        "criteria": criteria, "reports": reports, "artifacts": artifacts,
        # Exit status proves the CLI exited, not that tests or acceptance
        # criteria passed. Existing work-result evidence is agent-authored.
        "verification": "not_recorded",
        "canAccept": task["status"] == "review" and not task.get("deletedAt") and not task.get("isRoutine"),
        "missing": [key for key, present in (
            ("thread", bool(session)), ("criteria", bool(criteria)),
            ("reports", bool(reports)), ("artifacts", bool(artifacts)),
            ("verification", False),
        ) if not present],
    }
    # Include execution ownership and source versions even when a new round
    # produces an identical-looking result. No raw transcript enters the hash.
    revision_source = {
        "brief": brief, "executionOwner": task.get("executionOwner"),
        "taskVersion": task.get("eventCount", len(task.get("events", []))),
        "taskUpdatedAt": task.get("updatedAt"),
        "sourceVersion": source.get("eventCount"),
        "activeRoundId": source.get("activeRoundId"),
    }
    revision = hashlib.sha256(json.dumps(revision_source, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {**brief, "revision": revision}


def _report(run: dict[str, Any]) -> dict[str, Any]:
    work = run.get("workResult") or {}
    return {
        "runId": run["id"], "agent": run.get("agent"),
        "agentId": run.get("logicalAgentId"), "role": run.get("role"),
        "status": run.get("status"), "exitCode": run.get("exitCode"),
        "completedAt": run.get("completedAt"),
        "workStatus": work.get("status"), "note": work.get("note") or "",
        "evidence": list(work.get("evidence") or []),
        "findings": [item["note"] for item in work.get("findings", []) if item.get("note")],
        "outputTruncated": bool(run.get("outputTruncated")),
    }
