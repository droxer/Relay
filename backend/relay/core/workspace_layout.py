"""Workspace path conventions shared by the backend and the daemon."""

from __future__ import annotations

# A project that links an existing directory lives at `links/<id>` (never
# `projects/<id>`); only the daemon maps that subpath to the real directory.
LINKED_WORKSPACE_PREFIX = "links/"
