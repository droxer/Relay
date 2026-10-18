"""The caller a request acts for, as the API resolves it (``relay/api/actors.py``).

Three kinds reach a route — a signed-in account, the chat service speaking for
a user (``x-relay-user-id``), and a computer's node token speaking for its
owner — and all three take this one shape: whose authority the request
carries (``userId``) and whether that is an admin's. ``account`` is the login
record (synthesized for the chat-service and node-token kinds); a service that
checks a rule on a user's behalf may build an actor without one. Actors stay
plain dicts at runtime.
"""

from __future__ import annotations

from typing import Any, NotRequired, TypedDict


class Actor(TypedDict):
    userId: str
    isAdmin: bool
    account: NotRequired[dict[str, Any]]
