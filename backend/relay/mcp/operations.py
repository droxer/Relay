"""Project MCP operations reuse existing application rules, never HTTP self-calls."""

from typing import Any

from jsonschema import ValidationError, validate

from ..core.computer_identity import computer_id
from ..core.workflows import project_workflow_definition
from ..projects.manager import ManagerError
from ..projects.manager_reads import read_manager_tool
from ..projects.manager_proposals import stage_proposal
from ..projects.runtime import project_work_error
from ..projects.workflow import validate_project_workflow
from .access import assert_project_manage, scoped_project
from .catalog import CREATE_WORKFLOW_INPUT
from .errors import McpError


def list_projects(ctx: Any, grant: dict[str, Any]) -> dict[str, Any]:
    if grant.get("computerId") and not grant.get("commandId"):
        return {"projects": []}
    projects = ctx.project_store.list_projects(
        grant["ownerUserId"], include_archived=True,
        project_ids=grant.get("projectIds"), computer_id=grant.get("computerId") or None,
    )
    return {
        "projects": [
            {k: p.get(k) for k in ("id", "name", "goal", "computerId", "managerAgentId", "archivedAt")}
            for p in projects
            if (grant.get("projectIds") is None or p["id"] in grant["projectIds"])
            and (not grant.get("computerId") or p["computerId"] == grant["computerId"])
            and (not grant.get("commandId") or any(
                m.get("agentId") == grant.get("agentId") and m.get("enabled", True)
                for m in p.get("members") or []))
        ]
    }


def invoke(ctx: Any, grant: dict[str, Any], project_id: str, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if tool == "create_workflow":
        if not isinstance(arguments, dict) or arguments.get("projectId", project_id) != project_id:
            raise McpError(400, "Invalid Workflow tool arguments.")
        return _create_workflow(ctx, grant, {**arguments, "projectId": project_id})
    project = scoped_project(ctx, grant, project_id)
    if not isinstance(tool, str) or not isinstance(arguments, dict):
        raise McpError(400, "Invalid MCP tool request.")
    if arguments.get("projectId", project_id) != project_id:
        raise McpError(403, "Project scope mismatch.")
    try:
        if tool == "workspace":
            if code := project_work_error(project):
                raise ManagerError(code)
            nodes = ctx.registry.monitor_nodes_for_computers({project["computerId"]})
            node = next((node for node in nodes if computer_id(node) == project["computerId"]), None)
            return {
                "workspace": {
                    "root": (node or {}).get("workspacePath"),
                    "subpath": project["workspaceSubpath"],
                    "linkedPath": project.get("workspaceHostPath"),
                }
            }
        if tool == "propose":
            assert_project_manage(grant, project)
            if code := project_work_error(project):
                raise ManagerError(code)
            if not project.get("managerAgentId"):
                raise ManagerError("manager_unconfigured")
            active_command = ctx.daemon_store.get_command(grant["commandId"])
            if not active_command:
                raise McpError(401, "This Relay run has ended.")
            command = {**active_command["command"], "mcpTokenId": grant["id"]}
            return {"proposal": stage_proposal(ctx, project, command, arguments.get("operations"))}
        return read_manager_tool(ctx, project, tool, arguments)
    except ManagerError as error:
        raise McpError(error.status, error.code) from error


def _create_workflow(ctx: Any, grant: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    try:
        validate(payload, CREATE_WORKFLOW_INPUT)
    except ValidationError as error:
        raise McpError(400, "Invalid Workflow tool arguments.") from error
    project_id = payload["projectId"]
    assert_project_manage(grant, scoped_project(ctx, grant, project_id))
    owner = grant["ownerUserId"]
    # Keep the authorization check and write in the same transaction as Project changes.
    try:
        with ctx.registry.dispatch_lock, ctx.project_store.manager_transaction(project_id):
            assert_project_manage(grant, scoped_project(ctx, grant, project_id))
            definition = project_workflow_definition(owner, payload)
            validate_project_workflow(ctx, definition, require_enabled=False)
            return {"workflow": ctx.workflow_store.save_workflow(owner, payload)}
    except McpError:
        raise
    except ValueError as error:
        code = str(error)
        raise McpError(409 if code == "workflow_name_taken" else 400, code) from error
    except KeyError as error:
        if error.args != (project_id,):
            raise
        raise McpError(404, "project_not_found") from error
