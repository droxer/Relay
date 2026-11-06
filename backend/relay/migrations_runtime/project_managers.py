"""Backfill manager bindings without creating Threads or executing Agents."""
from typing import Any
from ..projects.manager import initialize_manager


def initialize_project_managers(ctx: Any) -> None:
    for project in ctx.project_store.list_projects(include_archived=False):
        initialize_manager(ctx, project)
