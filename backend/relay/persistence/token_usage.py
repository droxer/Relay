"""Token-usage arithmetic for session and run ledgers."""

from __future__ import annotations

from typing import Any


def split_cache_tokens(usage: dict[str, Any]) -> tuple[int, int]:
    """Cache (read, write) counts for a usage record.

    Records written before the split carry only the combined ``cache``; it is
    counted as reads, which is what almost all of it was. Mirrors
    ``splitCache`` in relay-core/src/token-usage.ts.
    """
    if usage.get("cacheRead") is None and usage.get("cacheWrite") is None:
        return int(usage.get("cache") or 0), 0
    return int(usage.get("cacheRead") or 0), int(usage.get("cacheWrite") or 0)


def build_token_usage(
    input_tokens: int, output_tokens: int, cache_read: int, cache_write: int
) -> dict[str, int] | None:
    cache = cache_read + cache_write
    if input_tokens == 0 and output_tokens == 0 and cache == 0:
        return None
    return {
        "input": input_tokens,
        "output": output_tokens,
        "cache": cache,
        "cacheRead": cache_read,
        "cacheWrite": cache_write,
        "total": input_tokens + output_tokens + cache,
    }


def merge_token_usage(values: list[dict[str, Any] | None]) -> dict[str, int] | None:
    input_tokens = output_tokens = cache_read = cache_write = 0
    for value in values:
        if not isinstance(value, dict):
            continue
        read, write = split_cache_tokens(value)
        input_tokens += int(value.get("input") or 0)
        output_tokens += int(value.get("output") or 0)
        cache_read += read
        cache_write += write
    return build_token_usage(input_tokens, output_tokens, cache_read, cache_write)
