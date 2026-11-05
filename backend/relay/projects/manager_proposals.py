"""Typed proposals: Agents stage; only the owner applies domain mutations."""
from __future__ import annotations

from datetime import date
from typing import Any
from ..core.ids import new_database_id, now_iso
from ..security.actor import Actor
from ..tasks.creation import TaskCreateRequest, create_task
from ..tasks.update import TaskPatchRequest, update_task
from ..tasks.requests import TaskRequestReader
from .manager import ManagerError
from .manager_reads import scoped_task, task_revision
from .runtime import project_work_error

FIELDS = {"title", "description", "priority", "dueDate", "tags", "assignedAgentId", "assignedTeamId"}


def checked_fields(raw: Any, *, create: bool = False) -> dict[str, Any]:
    if not isinstance(raw, dict) or not raw or set(raw) - FIELDS:
        raise ManagerError("manager_fields_invalid", 400)
    for key, value in raw.items():
        if key in ("title", "description") and (not isinstance(value, str) or len(value) > 20000):
            raise ManagerError("manager_text_invalid", 400)
        if key in ("assignedAgentId", "assignedTeamId") and value is not None and not isinstance(value, str):
            raise ManagerError("manager_assignment_invalid", 400)
    if (create or "title" in raw) and (not str(raw.get("title", "")).strip() or len(raw["title"]) > 200):
        raise ManagerError("manager_title_invalid", 400)
    if "priority" in raw and raw["priority"] not in ("low", "normal", "high", "urgent"):
        raise ManagerError("manager_priority_invalid", 400)
    if "tags" in raw and (not isinstance(raw["tags"], list) or len(raw["tags"]) > 50 or any(not isinstance(t, str) or len(t) > 100 for t in raw["tags"])):
        raise ManagerError("manager_tags_invalid", 400)
    if raw.get("dueDate") is not None:
        try:
            date.fromisoformat(raw["dueDate"])
        except (ValueError, TypeError) as error:
            raise ManagerError("manager_date_invalid", 400) from error
    return dict(raw)


def _ids(raw: Any) -> list[str]:
    if not isinstance(raw, list) or len(raw) > 10 or any(not isinstance(x, str) or not x for x in raw):
        raise ManagerError("manager_prerequisites_invalid", 400)
    return list(dict.fromkeys(raw))


def stage_proposal(ctx: Any, project: dict[str, Any], command: dict[str, Any], raw: Any) -> dict[str, Any]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 20:
        raise ManagerError("manager_operations_invalid", 400)
    with ctx.project_store.manager_transaction(project["id"]) as current:
        if code := project_work_error(current):
            raise ManagerError(code)
        operations = []
        keys: set[str] = set()
        for index, item in enumerate(raw):
            if not isinstance(item, dict) or item.get("kind") not in ("create", "update", "prerequisites"):
                raise ManagerError("manager_operation_invalid", 400)
            if set(item) - {"kind", "key", "fields", "taskId", "after", "afterTaskIds"}:
                raise ManagerError("manager_operation_invalid", 400)
            kind = item["kind"]
            fields = checked_fields(item.get("fields"), create=kind == "create") if kind != "prerequisites" else {}
            after = _ids(item.get("after", []))
            if any(key not in keys for key in after):
                raise ManagerError("manager_plan_order_invalid", 400)
            after_ids = _ids(item.get("afterTaskIds", []))
            for task_id in after_ids:
                scoped_task(ctx, current, task_id)
            op = {"id": str(index), "kind": kind, "fields": fields, "after": after, "afterTaskIds": after_ids}
            if kind == "create":
                key = item.get("key", f"task-{index}")
                if not isinstance(key, str) or not key or len(key) > 100 or key in keys:
                    raise ManagerError("manager_key_invalid", 400)
                keys.add(key)
                op["key"] = key
            else:
                task = scoped_task(ctx, current, item.get("taskId", ""))
                op.update(taskId=task["id"], expectedRevision=task_revision(task),
                          before={key: task.get(key) for key in fields}, title=task["title"])
            operations.append(op)
        proposal = {
            "id": new_database_id(), "projectId": current["id"], "threadId": command["sessionId"],
            "agentId": command.get("logicalAgentId"), "runId": command["runId"],
            "sourceMessageId": command.get("state", {}).get("user_message_id"),
            "operations": operations, "state": "pending", "revision": 1, "createdAt": now_iso(),
        }
        # A regenerated proposal for the same turn replaces its previous draft.
        for old in ctx.project_store.manager_proposals(current["id"]):
            if old["state"] == "pending" and old["runId"] == command["runId"]:
                ctx.project_store.save_manager_proposal({**old, "state": "superseded", "revision": old["revision"] + 1})
        ctx.project_store.save_manager_proposal(proposal, new=True)
        return proposal


def apply_proposal(ctx: Any, actor: Actor, project: dict[str, Any], proposal_id: str,
                   body: dict[str, Any], reader: TaskRequestReader) -> dict[str, Any]:
    key = body.get("idempotencyKey")
    if not isinstance(key, str) or not 1 <= len(key) <= 200:
        raise ManagerError("manager_idempotency_key_required", 400)
    with ctx.project_store.manager_transaction(project["id"]) as current:
        if current["ownerUserId"] != actor["userId"]:
            raise ManagerError("project_forbidden", 403)
        if code := project_work_error(current):
            raise ManagerError(code)
        proposal = ctx.project_store.manager_proposal(current["id"], proposal_id)
        if not proposal:
            raise ManagerError("proposal_not_found", 404)
        if proposal["state"] == "applied" and proposal.get("applicationKey") == key:
            if proposal.get("applicationInput") != body:
                raise ManagerError("manager_idempotency_conflict")
            return proposal["result"]
        if proposal["state"] != "pending" or body.get("expectedRevision", proposal["revision"]) != proposal["revision"]:
            raise ManagerError("manager_proposal_stale")
        selected = body.get("operationIds", [op["id"] for op in proposal["operations"]])
        if not isinstance(selected, list) or not selected or any(not isinstance(x, str) for x in selected) or len(set(selected)) != len(selected):
            raise ManagerError("manager_selection_invalid", 400)
        operations = [op for op in proposal["operations"] if op["id"] in selected]
        if len(operations) != len(selected):
            raise ManagerError("manager_selection_invalid", 400)
        edits = body.get("fields", {})
        if not isinstance(edits, dict) or set(edits) - set(selected):
            raise ManagerError("manager_fields_invalid", 400)
        task_ids = sorted({op["taskId"] for op in operations if op.get("taskId")})
        with ctx.project_store.manager_transaction(current["id"], task_ids):
            for op in operations:
                if op.get("taskId") and task_revision(scoped_task(ctx, current, op["taskId"])) != op["expectedRevision"]:
                    raise ManagerError("manager_task_stale")
            created: dict[str, str] = {}
            results = []
            for op in operations:
                fields = checked_fields(edits.get(op["id"], op["fields"]), create=op["kind"] == "create") if op["kind"] != "prerequisites" else {}
                if op["kind"] == "create":
                    task = create_task(ctx, actor, TaskCreateRequest(
                        body={**fields, "projectId": current["id"], "status": "backlog"}, reader=reader,
                        title=fields["title"].strip(), owner=actor["userId"], assignee=actor["userId"], project=current,
                        project_session_fields=lambda _p: {},
                    ))
                    created[op["key"]] = task["id"]
                else:
                    task = scoped_task(ctx, current, op["taskId"])
                    if fields:
                        def reload_task(task_id: str = task["id"]) -> dict[str, Any]:
                            return scoped_task(ctx, current, task_id)

                        task = update_task(ctx, actor, task, TaskPatchRequest(
                            body=fields, reader=reader, requested_assignee=None, move_project=None,
                            reload=reload_task,
                            automation_store=ctx.automation_store,
                        ))
                if any(k not in created for k in op["after"]):
                    raise ManagerError("manager_selected_prerequisite_missing", 400)
                prerequisites = [*op["afterTaskIds"], *[created[k] for k in op["after"]]]
                if prerequisites or op["kind"] == "prerequisites":
                    for task_id in op["afterTaskIds"]:
                        scoped_task(ctx, current, task_id)
                    task = ctx.task_store.set_task_prerequisites(task["id"], prerequisites, actor_user_id=actor["userId"])
                results.append(task)
            applied = {**proposal, "state": "applied", "revision": proposal["revision"] + 1,
                       "appliedBy": actor["userId"], "appliedAt": now_iso(), "applicationKey": key,
                       "applicationInput": body, "appliedOperationIds": selected}
            result = {"proposal": applied, "tasks": results}
            ctx.project_store.save_manager_proposal({**applied, "result": result})
            return result
