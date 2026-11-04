"""Validation of an administrator's per-user task capacity override."""

from typing import Any

MAX_CONCURRENT_TASKS = 100


def normalize_task_capacity(value: Any) -> int:
    if type(value) is not int or not 1 <= value <= MAX_CONCURRENT_TASKS:
        raise ValueError(f"maxConcurrentTasks must be an integer between 1 and {MAX_CONCURRENT_TASKS}.")
    return value
