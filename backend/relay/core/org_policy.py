"""Organization-wide limits whose defaults the schema and the settings store share."""

from __future__ import annotations

# How many times a task may be re-dispatched because its last round reported it
# unfinished. One means "no automatic continuation": the first round is not a
# continuation, so the cap only bounds the rounds that follow.
DEFAULT_MAX_TASK_ROUNDS = 5
MIN_MAX_TASK_ROUNDS = 1
MAX_MAX_TASK_ROUNDS = 50
