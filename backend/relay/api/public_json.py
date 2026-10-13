"""JSON responses that never carry private snapshot bookkeeping.

``_legacyRoutine`` is replay state the task reducer keeps on a snapshot, not part
of the API. One response class strips it, so no route has to remember to. Only
the named private keys go: other payloads may carry user data with any key.
"""

from __future__ import annotations

from typing import Any

from fastapi.responses import JSONResponse

PRIVATE_SNAPSHOT_KEYS = frozenset({"_legacyRoutine"})


def public_payload(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: public_payload(item) for key, item in value.items() if key not in PRIVATE_SNAPSHOT_KEYS}
    if isinstance(value, list):
        return [public_payload(item) for item in value]
    return value


class PublicJSONResponse(JSONResponse):
    def render(self, content: Any) -> bytes:
        return super().render(public_payload(content))
