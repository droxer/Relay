"""Serving the exported web UI and its cache policy.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from fastapi import Response
from fastapi.responses import HTMLResponse, JSONResponse
from ..contract import WEB_UI_ROUTE_ROOTS


def web_ui_asset_response(asset_path: str, configured_dir: Path | None = None) -> Response:
    candidates = [
        str(configured_dir) if configured_dir else None,
        str(Path.cwd() / "web" / "out"),
        str(Path(__file__).resolve().parents[3] / "web" / "out"),
    ]
    dist = next(
        (Path(path) for path in candidates if path and Path(path).is_dir()), None
    )
    if not dist:
        return HTMLResponse(
            "Relay web UI has not been built. Run `npm run build -w web`.\n",
            status_code=404,
        )
    requested = asset_path or "index.html"
    asset = (dist / requested).resolve()
    confined = asset.is_relative_to(dist.resolve())
    if not confined or not asset.exists() or not asset.is_file():
        root = asset_path.split("/", 1)[0]
        # A pathname with a file suffix is an asset request, never a client
        # route. Do not turn missing scripts/styles/images into successful HTML.
        if root not in WEB_UI_ROUTE_ROOTS or Path(asset_path).suffix:
            return JSONResponse({"detail": "Not found."}, status_code=404)
        asset = dist / "index.html"
    if not asset.exists():
        return JSONResponse({"error": "Web UI asset not found."}, status_code=404)
    content_type = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
    return Response(
        asset.read_bytes(),
        media_type=content_type,
        headers={"Cache-Control": web_ui_cache_control(asset.resolve().relative_to(dist.resolve()))},
    )


def web_ui_cache_control(relative: Path) -> str:
    """The same split as web/Caddyfile: content-hashed files are kept, while
    pages and fixed-name files (favicon, images) revalidate so a deploy shows."""
    if relative.parts[:2] == ("_next", "static"):
        return "public, max-age=31536000, immutable"
    if relative.parts[:1] == ("landing",):
        return "public, max-age=86400"
    return "no-cache"
