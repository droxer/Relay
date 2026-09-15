#!/usr/bin/env python3
"""Seed curated demo content for the reusable local demo user via HTTP.

Computers, agents, teams, tasks, and threads go through the real routes so
every event and snapshot stays consistent. Threads are linked to seeded tasks
so team activity views are populated without executing agents.

Run with ``RELAY_DEMO_PASSWORD=<password> python3 script/seed_demo.py``. Set
``RELAY_DEMO_BASE_URL`` or ``RELAY_DEMO_USERNAME`` to target another local
test instance or account.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

BASE = os.environ.get(
    "RELAY_DEMO_BASE_URL", "http://127.0.0.1:5000/api/v1"
).rstrip("/")
USERNAME = os.environ.get("RELAY_DEMO_USERNAME", "demo")
PASSWORD = os.environ.get("RELAY_DEMO_PASSWORD")
if not PASSWORD:
    raise SystemExit("RELAY_DEMO_PASSWORD is required.")

cookie: str | None = None


def call(method: str, path: str, body: dict | None = None, token: str | None = None):
    global cookie
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    if cookie:
        req.add_header("Cookie", cookie)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as res:
            set_cookie = res.headers.get("Set-Cookie")
            if set_cookie:
                cookie = set_cookie.split(";")[0]
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as error:
        detail = error.read().decode()
        raise SystemExit(f"{method} {path} -> {error.code}: {detail}")


# --- sign in -------------------------------------------------------------
call("POST", "/auth/login", {"username": USERNAME, "password": PASSWORD})
me = call("GET", "/auth/me")
print("signed in as", me["user"]["username"])

# --- computers -----------------------------------------------------------
computers = {}
for name, workspace, workspace_id in (
    ("Ada's MacBook Pro", "/Users/ada/relay-workspace", "demo-ada-macbook"),
):
    enrolled = call(
        "POST",
        "/daemon-node-enrollments/local",
        {"workspacePath": workspace, "displayName": name},
    )
    node = enrolled["node"]
    token = enrolled.get("nodeToken")
    registration = call(
        "POST",
        "/daemon-node-registrations",
        {
            "sandboxId": node["id"],
            "token": token,
            "protocolVersion": 2,
            "workspacePath": workspace,
            "workspaceId": workspace_id,
            "sandboxMode": "none",
            "supportedAgents": ["claude", "codex", "kimi", "pi"],
            "maxConcurrentRuns": 4,
            "status": "ready",
        },
        token=token,
    )
    computers[name] = {
        "id": node["id"],
        "computerId": f"device:{registration['employeeId']}:{workspace_id}",
        "token": token,
    }
    print("computer", name, node["id"], registration.get("status"))

# --- agents ---------------------------------------------------------------
agents = {}
existing_agents = {
    item["displayName"]: item for item in call("GET", "/agents").get("agents", [])
}
for display, kind, role, computer in (
    ("Aria", "claude", "implementer", "Ada's MacBook Pro"),
    ("Cascade", "codex", "reviewer", "Ada's MacBook Pro"),
    ("Pixel", "kimi", "tester", "Ada's MacBook Pro"),
    ("Kimi Ops", "kimi", "fixer", "Ada's MacBook Pro"),
):
    if display in existing_agents:
        agents[display] = existing_agents[display]["id"]
        print("agent", display, agents[display], "(existing)")
        continue
    created = call(
        "POST",
        "/agents",
        {
            "computerId": computers[computer]["computerId"],
            "executorKind": kind,
            "defaultRole": role,
            "displayName": display,
        },
    )
    agent = created["agent"]
    agents[display] = agent["id"]
    print("agent", display, agent["id"])

# --- teams ----------------------------------------------------------------
teams = {}
existing_teams = {
    item["name"]: item for item in call("GET", "/teams").get("teams", [])
}
for name, lead, members in (
    ("Platform Guild", "Aria", ["Aria", "Cascade"]),
    ("Infra Response", "Cascade", ["Cascade", "Aria", "Pixel"]),
    ("Growth Pod", "Pixel", ["Pixel", "Kimi Ops"]),
):
    if name in existing_teams:
        teams[name] = existing_teams[name]["id"]
        print("team", name, teams[name], "(existing)")
        continue
    created = call(
        "POST",
        "/teams",
        {
            "name": name,
            "leadAgentId": agents[lead],
            "memberAgentIds": [agents[m] for m in members],
        },
    )
    team = created["team"]
    teams[name] = team["id"]
    print("team", name, team["id"])

# --- tasks ----------------------------------------------------------------
tasks = [
    # (title, priority, due, assignee team/agent, final status)
    (
        "Add per-tenant rate limiting to the public API",
        "normal",
        "2026-09-20",
        ("team", "Platform Guild"),
        "backlog",
    ),
    (
        "Investigate dashboard chart slowdown",
        "low",
        None,
        ("agent", "Cascade"),
        "backlog",
    ),
    (
        "Tune infra alert thresholds",
        "normal",
        "2026-09-16",
        ("team", "Infra Response"),
        "assigned",
    ),
    (
        "Fix billing export race condition",
        "high",
        "2026-09-14",
        ("team", "Platform Guild"),
        "assigned",
    ),
    (
        "Ship referral-link growth experiment",
        "low",
        None,
        ("team", "Growth Pod"),
        "assigned",
    ),
    (
        "Redesign onboarding checklist flow",
        "normal",
        "2026-09-18",
        ("team", "Platform Guild"),
        "assigned",
    ),
    (
        "Draft Q4 capacity plan for shared runners",
        "normal",
        "2026-09-25",
        None,
        "backlog",
    ),
]
existing_tasks = {
    item["title"]: item for item in call("GET", "/tasks").get("tasks", [])
}
seeded_tasks = {}
for title, priority, due, assignee, status in tasks:
    task = existing_tasks.get(title)
    if not task:
        body: dict = {"title": title, "priority": priority}
        if due:
            body["dueDate"] = due
        if assignee:
            kind, name = assignee
            if kind == "team":
                body["assignedTeamId"] = teams[name]
            else:
                body["assignedAgentId"] = agents[name]
        created = call("POST", "/tasks", body)
        task = created.get("task", created)

    transition_path = {
        "backlog": ["backlog"],
        "assigned": ["assigned"],
        "running": ["assigned", "running"],
        "waiting_for_human": ["assigned", "running", "waiting_for_human"],
        "review": ["assigned", "running", "review"],
    }[status]
    for next_status in transition_path:
        if task.get("status") == next_status:
            continue
        updated = call("PATCH", f"/tasks/{task['id']}", {"status": next_status})
        task = updated.get("task", updated)
    seeded_tasks[title] = task
    print(
        "task",
        title,
        "->",
        task["status"],
        "(existing)" if title in existing_tasks else "",
    )

# --- threads --------------------------------------------------------------
existing_threads = {
    item.get("taskGoal"): item
    for item in call("GET", "/threads").get("sessions", [])
    if item.get("taskGoal")
}
for title in (
    "Fix billing export race condition",
    "Redesign onboarding checklist flow",
    "Add per-tenant rate limiting to the public API",
    "Investigate dashboard chart slowdown",
):
    if title in existing_threads:
        print("thread", title, "(existing)")
        continue
    created = call(
        "POST",
        "/threads",
        {"taskGoal": title, "taskId": seeded_tasks[title]["id"]},
    )
    print("thread", title, created["id"])

print(
    json.dumps(
        {
            "computers": {
                name: {"id": item["id"], "computerId": item["computerId"]}
                for name, item in computers.items()
            },
            "agents": agents,
            "teams": teams,
        },
        indent=2,
    )
)
