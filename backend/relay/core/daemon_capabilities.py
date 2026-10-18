"""The capability vocabulary daemons advertise at registration.

A capability names a wire behaviour a daemon supports, so the backend can gate a
feature per computer instead of per release. This module is the one list of
them; ``packages/relay-core/src/daemon-node-protocol.ts`` is its TypeScript
mirror and ``tests/unit/test_client_version_parity.py`` pins the two together.

Whether a computer runs an older client is also decided here. Every package
still reports version 0.1.0, so a version string cannot tell an old daemon from
a new one; capabilities can. A current daemon advertises every capability in
``DAEMON_NODE_CAPABILITIES``, so a registered computer missing any of them is
running an older client. A capability a daemon advertises only in some modes
must never join that set, or every such computer would read as outdated.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

DAEMON_CAPABILITY_WORK_RESULTS = "work-results"
DAEMON_CAPABILITY_AGENT_SKILLS = "agent-skills"
DAEMON_CAPABILITY_RUNTIME_REFRESH = "runtime-refresh"
DAEMON_CAPABILITY_PROJECT_WORKSPACE_DELETE = "project-workspace-delete"
DAEMON_CAPABILITY_GENERATED_FILES = "generated-files"
DAEMON_CAPABILITY_WORKSPACE_READ_SHARED = "workspace-read-shared"
DAEMON_CAPABILITY_STRUCTURED_AGENT_EVENTS = "structured-agent-events"
DAEMON_CAPABILITY_THREAD_WORKSPACES = "thread-workspaces"
DAEMON_CAPABILITY_PROJECT_WORKSPACES = "project-workspaces"
DAEMON_CAPABILITY_TASK_WORKSPACES = "task-workspaces"
DAEMON_CAPABILITY_ROUND_RESULT = "round-result"
DAEMON_CAPABILITY_PRODUCED_FILES = "produced-files"
# The daemon passes an agent's pinned model to its runtime CLI.
DAEMON_CAPABILITY_AGENT_MODEL = "agent-model"
# A runtime behind a custom endpoint reports only the models that endpoint lists.
DAEMON_CAPABILITY_ENDPOINT_MODELS = "endpoint-models"
DAEMON_CAPABILITY_HANDOFF_VALIDATION = "handoff-validation"
DAEMON_CAPABILITY_EXECUTION_JOURNAL_REPORT = "execution-journal-report"
DAEMON_CAPABILITY_AGENT_RESUME = "agent-resume"
# The daemon reports a setup round's proposal file on run.completed.
DAEMON_CAPABILITY_PROJECT_SETUP = "project-setup"
# The daemon links existing directories as project workspaces (`links/<id>`).
DAEMON_CAPABILITY_PROJECT_LINKS = "project-links"

DAEMON_NODE_CAPABILITIES = frozenset(
    {
        DAEMON_CAPABILITY_WORK_RESULTS,
        DAEMON_CAPABILITY_AGENT_SKILLS,
        DAEMON_CAPABILITY_RUNTIME_REFRESH,
        DAEMON_CAPABILITY_PROJECT_WORKSPACE_DELETE,
        DAEMON_CAPABILITY_GENERATED_FILES,
        DAEMON_CAPABILITY_WORKSPACE_READ_SHARED,
        DAEMON_CAPABILITY_STRUCTURED_AGENT_EVENTS,
        DAEMON_CAPABILITY_THREAD_WORKSPACES,
        DAEMON_CAPABILITY_PROJECT_WORKSPACES,
        DAEMON_CAPABILITY_TASK_WORKSPACES,
        DAEMON_CAPABILITY_ROUND_RESULT,
        DAEMON_CAPABILITY_PRODUCED_FILES,
        DAEMON_CAPABILITY_HANDOFF_VALIDATION,
        DAEMON_CAPABILITY_AGENT_MODEL,
        DAEMON_CAPABILITY_ENDPOINT_MODELS,
        DAEMON_CAPABILITY_EXECUTION_JOURNAL_REPORT,
        DAEMON_CAPABILITY_AGENT_RESUME,
        DAEMON_CAPABILITY_PROJECT_SETUP,
        DAEMON_CAPABILITY_PROJECT_LINKS,
    }
)


def has_capability(node: Mapping[str, Any] | None, capability: str) -> bool:
    """Whether a node record advertises ``capability``."""
    if not node:
        return False
    return capability in (node.get("capabilities") or [])


def missing_capabilities(
    node: Mapping[str, Any], known: frozenset[str] = DAEMON_NODE_CAPABILITIES,
) -> list[str]:
    """Capabilities this backend knows that the computer did not advertise.

    Empty for a computer that never registered: a provisioned placeholder has
    reported nothing yet, which is not the same as reporting an old client.
    """
    if not node.get("lastSeenAt"):
        return []
    advertised = set(node.get("capabilities") or [])
    return sorted(known - advertised)


def client_outdated(node: Mapping[str, Any]) -> bool:
    return bool(missing_capabilities(node))
