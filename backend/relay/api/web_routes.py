from __future__ import annotations

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse

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
@router.get("/{asset_path:path}", include_in_schema=False)
def web_asset(asset_path: str = "") -> Response:
    return web_ui_asset_response(asset_path)
