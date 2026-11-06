"""Project setup HTTP orchestration and its draft lifecycle."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from ...collaboration.models import RunIntent
from ...collaboration.errors import CollaborationError
from ...collaboration.service import CollaborationConductor
from ...core.daemon_capabilities import DAEMON_CAPABILITY_PROJECT_SETUP, has_capability
from ...persistence.project.store import ProjectVersionConflict
from ...projects.runtime import project_runtime_node, project_work_error
from ...projects.setup import (
    ProjectSetupError, annotate_setup, choose_setup_agent, drafting_setup,
    plan_open_tasks, setup_candidates, setup_in_progress, setup_intent,
    setup_manifest_block, setup_mode, setup_task_goal,
)
from ...security.actor import Actor
from ..actors import request_actor
from ..bodies import JsonBodyDep
from ..deps import AppContextDep
from .access import require_owned_project
from .setup_task import close_setup_task, discard_setup_task

router = APIRouter()


@router.get("/projects/{project_id}/setup")
def get_project_setup(
    project_id: str, request: Request, ctx: AppContextDep
) -> dict[str, Any]:
    """The project's agent-drafted setup, with each proposed member's current
    eligibility, and the agents a setup could staff."""
    actor = request_actor(request, ctx.auth_store)
    project = require_owned_project(ctx, project_id, actor["userId"])
    return {
        "setup": annotate_setup(
            project,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
        ),
        "candidates": setup_candidates(
            project,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
        ),
    }


@dataclass(frozen=True)
class _PreparedSetup:
    actor: Actor
    intent: RunIntent
    draft: dict[str, Any]
    previous: dict[str, Any] | None
    revising: bool


def _prepare_project_setup(
    project_id: str, request: Request, ctx: AppContextDep, body: dict[str, Any]
) -> _PreparedSetup:
    """Prepare and claim a draft on one worker, including its task transaction."""
    actor = request_actor(request, ctx.auth_store)
    project = require_owned_project(ctx, project_id, actor["userId"])
    if code := project_work_error(project):
        raise HTTPException(409, code)
    try:
        intent = setup_intent(body.get("intent"))
        mode = setup_mode(body.get("mode"), project)
        if mode == "setup" and project.get("workspaceHostPath"):
            # An existing project keeps the name, brief, and roster its owner
            # gave it; only planning further work is drafted for it.
            raise ProjectSetupError("project_setup_fresh_only")
        candidates = setup_candidates(
            project,
            agent_store=ctx.agent_store,
            placement_store=ctx.agent_placement_store,
        )
        previous = project.get("setup") or None
        revising = (
            bool(body.get("revise"))
            and bool(previous and previous.get("threadId"))
            and (previous or {}).get("mode", "setup") == mode
        )
        if setup_in_progress(previous, ctx.session_store):
            raise ProjectSetupError("project_setup_in_progress")
        agent_id = choose_setup_agent(
            candidates,
            body.get("agentId") or (previous.get("agentId") if revising and previous else None),
            lead_agent_id=project.get("leadAgentId"),
        )
        node = project_runtime_node(project, ctx.registry.monitor_nodes())
        if node is None:
            raise ProjectSetupError("project_computer_offline")
        if not has_capability(node, DAEMON_CAPABILITY_PROJECT_SETUP):
            raise ProjectSetupError("project_setup_unsupported")
    except ProjectSetupError as error:
        raise HTTPException(error.status, error.code) from error
    previous_proposal = (previous or {}).get("proposal") if revising else None
    thread_id = previous["threadId"] if revising and previous else None
    # Record the draft before dispatch so a fast result always finds it.
    draft = drafting_setup(
        intent=intent, agent_id=agent_id, thread_id=thread_id, previous=previous if revising else None,
        mode=mode,
    )

    def claim_draft(latest: dict[str, Any]) -> dict[str, Any]:
        if code := project_work_error(latest):
            raise ProjectSetupError(code)
        if setup_in_progress(latest.get("setup"), ctx.session_store):
            raise ProjectSetupError("project_setup_in_progress")
        if (latest.get("setup") or None) != previous:
            raise ProjectVersionConflict(project_id)
        return draft

    open_tasks = (
        plan_open_tasks(
            project, ctx.task_store.list_task_summaries(user_id=project["ownerUserId"]),
        )
        if mode == "plan" else None
    )
    goal = setup_task_goal(intent, revising=revising, mode=mode)

    def claim_with_task(latest: dict[str, Any]) -> dict[str, Any]:
        claimed = claim_draft(latest)
        # The project mutation and task creation share one transaction. A
        # competing draft can never leave an orphan task behind.
        candidate = next(item for item in candidates if item["agentId"] == agent_id)
        task = ctx.task_store.create_task({
            "title": goal[:200],
            "description": goal,
            "projectId": project_id,
            "ownerUserId": project["ownerUserId"],
            "assigneeUserId": project["ownerUserId"],
            "assignedAgentId": agent_id,
            "assignedAgent": candidate["executorKind"],
        })
        if thread_id:
            ctx.task_store.link_session(task["id"], thread_id)
        return {**claimed, "taskId": task["id"], "nameAtStart": latest["name"]}

    project = _mutate_setup(ctx, project_id, claim_with_task)
    draft = project["setup"]
    intent_record = RunIntent(
        task_goal=goal,
        task_id=draft["taskId"],
        session_id=thread_id,
        raw_assignments=[{"agentId": agent_id, "mode": "action"}],
        requested_project_id=project_id,
        idempotency_key=body.get("idempotencyKey") if isinstance(body.get("idempotencyKey"), str) else None,
        source="project_setup",
        project_setup=setup_manifest_block(
            intent=intent,
            candidates=candidates,
            previous_proposal=previous_proposal,
            draft_id=draft["draftId"],
            mode=mode,
            open_tasks=open_tasks,
        ),
    )
    return _PreparedSetup(actor, intent_record, draft, previous, revising)


@router.post("/projects/{project_id}/setup", status_code=202)
async def start_project_setup(
    project_id: str, request: Request, ctx: AppContextDep, *, _request_body: JsonBodyDep
) -> dict[str, Any]:
    """Ask an agent on the project's computer to draft the project's setup.

    With `revise: true` the same thread drafts again from the last proposal
    and the owner's note; otherwise a fresh setup thread starts.
    """
    prepared = await run_in_threadpool(_prepare_project_setup, project_id, request, ctx, _request_body)
    draft, previous, revising = prepared.draft, prepared.previous, prepared.revising
    try:
        session = await CollaborationConductor(ctx).submit(prepared.intent, prepared.actor)
    except CollaborationError as error:
        await run_in_threadpool(_undo_draft, ctx, project_id, draft, previous if revising else None, error.code)
        detail: Any = str(error) if error.status in (400, 403) else {"code": error.code, "message": str(error)}
        raise HTTPException(error.status, detail) from error
    except Exception:
        # Whatever failed, the draft must not wait forever on a run that
        # never started, nor leave its task in the backlog.
        await run_in_threadpool(
            _undo_draft, ctx, project_id, draft, previous if revising else None, "project_setup_dispatch_failed"
        )
        raise

    def attach_thread(latest: dict[str, Any]) -> dict[str, Any] | None:
        current = latest.get("setup") or {}
        if (
            current.get("state") != "drafting"
            or current.get("draftId") != draft["draftId"]
            or current.get("threadId") == session["id"]
        ):
            return None
        return {**current, "threadId": session["id"]}

    project = await run_in_threadpool(_mutate_setup, ctx, project_id, attach_thread)
    # The draft this one replaces is settled: its run is over and its
    # proposal superseded.
    await run_in_threadpool(close_setup_task, ctx, previous)
    return {"project": project, "threadId": session["id"]}


def _undo_draft(
    ctx: Any,
    project_id: str,
    draft: dict[str, Any],
    previous: dict[str, Any] | None,
    failure_code: str,
) -> None:
    """Undo only our own draft: a revise falls back to the setup it was
    revising, a fresh start is marked failed so it never waits forever."""
    # Admission can fail before a daemon request exists to settle the task.
    discard_setup_task(ctx, draft)

    def restore(latest: dict[str, Any]) -> dict[str, Any] | None:
        current = latest.get("setup") or {}
        if current.get("state") != "drafting" or current.get("draftId") != draft["draftId"]:
            return None
        if previous:
            return previous
        # The unstarted task was just discarded; a failed draft names no task
        # rather than one that no longer exists.
        failed = {key: value for key, value in current.items() if key != "taskId"}
        return {**failed, "state": "failed", "error": failure_code}

    _mutate_setup(ctx, project_id, restore)


def _mutate_setup(
    ctx: Any, project_id: str, change: Callable[[dict[str, Any]], dict[str, Any] | None]
) -> dict[str, Any]:
    try:
        return ctx.project_store.mutate_setup(project_id, change)
    except KeyError as error:
        raise HTTPException(404, "Project not found.") from error
    except ProjectVersionConflict as error:
        raise HTTPException(409, "project_version_conflict") from error
    except ProjectSetupError as error:
        raise HTTPException(error.status, error.code) from error
