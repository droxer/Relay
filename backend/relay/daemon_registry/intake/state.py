"""The state every ``ServerDaemonNodeBackend`` mixin shares.

The node backend is split by concern into mixins (``idempotency``,
``validation``, ``ownership``, ``intent``). ``ServerDaemonNodeBackend.__init__``
(``node_backend.py``) owns and initializes these attributes; this class only
declares them so each mixin reads as code against a known shape.
"""

from __future__ import annotations

from typing import Any

from ...persistence.protocols import AgentPlacementStore, AgentStore
from ..registry import DaemonNodeRegistry


class NodeBackendState:
    registry: DaemonNodeRegistry
    agent_store: AgentStore | None
    agent_placement_store: AgentPlacementStore | None
    skill_store: Any | None
    team_store: Any | None
    project_store: Any | None
