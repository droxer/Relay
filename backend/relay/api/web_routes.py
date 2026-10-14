from __future__ import annotations

from pathlib import PurePosixPath

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from ..core.deploy_config import public_web_url
from .contract import WEB_UI_ROUTE_ROOTS
from .helpers import web_ui_asset_response

router = APIRouter()


@router.api_route(
    "/{unknown_path:path}",
    methods=["POST", "PUT", "PATCH", "DELETE"],
    include_in_schema=False,
)
def unknown_non_get_route(unknown_path: str) -> JSONResponse:
    return JSONResponse({"detail": "Not found."}, status_code=404)


# Catch-all for the exported web UI served at the root path. Registered last in
# app.py so explicit API routes take precedence.
# When the web UI lives on its own origin, a client route requested from the
# API host is redirected there instead of being served.
@router.get("/{asset_path:path}", include_in_schema=False)
def web_asset(request: Request, asset_path: str = "") -> Response:
    web_origin = public_web_url()
    if web_origin and _is_client_route(asset_path):
        query = f"?{request.url.query}" if request.url.query else ""
        return RedirectResponse(f"{web_origin}/{asset_path}{query}", status_code=307)
    return web_ui_asset_response(asset_path)


def _is_client_route(asset_path: str) -> bool:
    root = asset_path.split("/", 1)[0]
    return not asset_path or (
        root in WEB_UI_ROUTE_ROOTS and not PurePosixPath(asset_path).suffix
    )
