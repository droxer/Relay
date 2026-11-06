"""The Project Lead carries management authority without a second assignment."""
from relay.core.project_roles import manager_run_context, project_reader_context, project_with_manager


def test_existing_project_management_follows_the_lead_without_mutating_storage():
    stored = {"id": "p", "version": 4, "leadAgentId": "lead", "managerAgentId": "former",
              "members": [{"agentId": "lead", "role": "reviewer", "enabled": True},
                          {"agentId": "former", "role": "planner", "projectManager": True}]}
    project = project_with_manager(stored)
    assert project["managerAgentId"] == "lead"
    assert project["members"][0]["projectManager"] is True
    assert "projectManager" not in project["members"][1]
    assert stored["members"][1]["projectManager"] is True
    assert project["version"] == stored["version"]


def test_only_enabled_lead_gets_management_tools_even_with_stale_manager_flags():
    project = {"id": "p", "version": 4, "leadAgentId": "lead", "members": [
        {"agentId": "lead", "enabled": True}, {"agentId": "former", "projectManager": True}]}
    assert manager_run_context(project, "lead")["agentId"] == "lead"
    assert manager_run_context(project, "former") is None
    snapshot = {**project, "projectId": "p", "projectRevision": 4}
    assert project_reader_context(snapshot, "former")["agentId"] == "former"
    assert project_reader_context(snapshot, "lead") is None
    project["members"][0]["enabled"] = False
    assert manager_run_context(project, "lead") is None


def test_project_without_lead_has_no_manager_even_if_legacy_flag_remains():
    project = project_with_manager({"members": [{"agentId": "former", "projectManager": True}]})
    assert project["managerAgentId"] is None
    assert "projectManager" not in project["members"][0]
