"""Shortcuts for tests that need an automation occurrence but are not
testing how automations fire."""


def fire_now(task_store, routine_id, *, run_date="2026-10-13", kind="schedule"):
    return task_store.create_triggered_occurrence(
        routine_id, run_date=run_date, trigger_kind=kind, depth=0, context="", summary=None, allow_paused=True)


def schedule_trigger(repeat, timezone="UTC"):
    return {"kind": "schedule", "schedule": {"timezone": timezone, "repeat": repeat}}


DAILY_TRIGGERS = [schedule_trigger({"every": "day", "at": "09:00"})]
WEEKLY_TRIGGERS = [schedule_trigger({"every": "week", "at": "09:00", "days": [4]})]


def active_routine(triggers=None):
    """The v2 routine fields of an active automation for a ``POST /tasks`` body."""
    return {"isRoutine": True, "routineState": "active",
            "routineTriggers": WEEKLY_TRIGGERS if triggers is None else triggers}


def paused_routine(triggers=None):
    return {**active_routine(triggers), "routineState": "paused"}


def computer_for_automation(client, owner=None, *, agent=None):
    """Explicitly provision an offline Computer for API automation fixtures."""
    from relay.core.computer_identity import computer_id
    if agent:
        placements = client.app.state.agent_placement_store
        active = [p for p in placements.list_placements(agent_id=agent["id"])
                  if p.get("desiredState") != "removed" and p.get("computerId")]
        if active:
            return active[-1]["computerId"]
        identity = agent.get("computerId") or computer_for_automation(client, agent["supervisorUserId"])
        node = next(node for node in client.app.state.registry.monitor_nodes()
                    if computer_id(node) == identity)
        placements.create_placement(agent, node["id"], {"computerId": identity})
        return identity
    account = client.get("/api/v1/auth/me").json()["user"]
    if not owner or account["role"] != "admin":
        owner = account["userId"]
    existing = [node for node in client.app.state.registry.monitor_nodes()
                if node.get("userId") == owner and not node.get("retiredAt")]
    if len(existing) == 1:
        return computer_id(existing[0])
    node_id = f"automation-fixture-{owner}"
    node = client.app.state.registry.get(node_id)
    if not node:
        node = client.app.state.registry.register({
            "sandboxId": node_id, "userId": owner, "workspaceId": node_id,
            "token": "fixture-token", "protocolVersion": 1,
            "workspacePath": f"/workspace/{owner}", "supportedAgents": [],
            "capabilities": ["workspace-scope", "thread-workspaces", "task-workspaces"],
            "status": "stopped",
        })
    return computer_id(node)
