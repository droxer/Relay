"""Shared browser origin policy for cookie requests and authenticated MCP HTTP."""

import re
from starlette.types import Scope
from ..core import deploy_config


def request_origin_allowed(scope: Scope, headers: dict[str, str], origin: str) -> bool:
    host = headers.get("host", "")
    if host and origin == f"{scope.get('scheme', 'http')}://{host}":
        return True
    if origin in deploy_config.cors_allow_origins():
        return True
    pattern = deploy_config.cors_allow_origin_regex()
    return bool(pattern and re.fullmatch(pattern, origin))
