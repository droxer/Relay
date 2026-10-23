"""Serving the exported web UI and its cache policy.

The export directory is resolved once per configured location and each file's
bytes are kept in a bounded in-process cache keyed by its mtime and size, so a
page load costs no directory probes or disk reads after the first. Every
asset carries a strong ETag; a revalidating ``no-cache`` page answers 304 to
a matching ``If-None-Match`` instead of resending the HTML.
"""

from __future__ import annotations

import mimetypes
from functools import lru_cache
from pathlib import Path

from fastapi import Response
from fastapi.responses import HTMLResponse, JSONResponse

from ..contract import WEB_UI_ROUTE_ROOTS

# The export is a few hundred files; a bound keeps a scan of made-up names
# from growing the cache, and the mtime/size key drops a rebuilt file's copy.
ASSET_CACHE_MAX_ENTRIES = 512


def web_ui_asset_response(asset_path: str, configured_dir: Path | None = None, *,
                          if_none_match: str | None = None) -> Response:
    dist = web_ui_dist_dir(str(configured_dir) if configured_dir else None)
    if not dist:
        return HTMLResponse(
            "Relay web UI has not been built. Run `npm run build -w web`.\n",
            status_code=404,
        )
    requested = asset_path or "index.html"
    asset = (dist / requested).resolve()
    confined = asset.is_relative_to(dist)
    if not confined or not asset.exists() or not asset.is_file():
        root = asset_path.split("/", 1)[0]
        # A pathname with a file suffix is an asset request, never a client
        # route. Do not turn missing scripts/styles/images into successful HTML.
        if root not in WEB_UI_ROUTE_ROOTS or Path(asset_path).suffix:
            return JSONResponse({"detail": "Not found."}, status_code=404)
        asset = dist / "index.html"
    try:
        stat = asset.stat()
    except OSError:
        return JSONResponse({"error": "Web UI asset not found."}, status_code=404)
    etag = asset_etag(stat.st_mtime_ns, stat.st_size)
    headers = {
        "Cache-Control": web_ui_cache_control(asset.resolve().relative_to(dist)),
        "ETag": etag,
    }
    if if_none_match is not None and etag_in(if_none_match, etag):
        return Response(status_code=304, headers=headers)
    content_type = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
    return Response(
        _asset_bytes(str(asset), stat.st_mtime_ns, stat.st_size),
        media_type=content_type,
        headers=headers,
    )


def web_ui_dist_dir(configured_dir: str | None) -> Path | None:
    """Resolve exports without caching misses before the first build."""
    try:
        return _cached_web_ui_dist_dir(configured_dir)
    except FileNotFoundError:
        return None


@lru_cache(maxsize=8)
def _cached_web_ui_dist_dir(configured_dir: str | None) -> Path:
    """The export directory for this configuration, probed once.

    Only a found directory is remembered: a backend started before the first
    ``npm run build -w web`` still picks the export up when it appears.
    """
    candidates = [
        configured_dir,
        str(Path.cwd() / "web" / "out"),
        str(Path(__file__).resolve().parents[3] / "web" / "out"),
    ]
    found = next((Path(path) for path in candidates if path and Path(path).is_dir()), None)
    if found is None:
        # lru_cache does not cache exceptions, so a later build is discovered.
        raise FileNotFoundError("Web UI export not built.")
    return found.resolve()


@lru_cache(maxsize=ASSET_CACHE_MAX_ENTRIES)
def _asset_bytes(path: str, _mtime_ns: int, _size: int) -> bytes:
    return Path(path).read_bytes()


def asset_etag(mtime_ns: int, size: int) -> str:
    """A strong validator: the export is rebuilt wholesale, so a file's mtime
    and size change together with its content."""
    return f'"{mtime_ns:x}-{size:x}"'


def etag_in(if_none_match: str, etag: str) -> bool:
    """Strong comparison of ``If-None-Match`` against this asset's ETag.

    A proxy that recompressed the asset may hand the browser a weak form of
    the same tag; it names the same bytes, so it is accepted too.
    """
    candidates = {part.strip() for part in if_none_match.split(",")}
    return "*" in candidates or etag in candidates or f"W/{etag}" in candidates


def web_ui_cache_control(relative: Path) -> str:
    """The same split as web/Caddyfile: content-hashed files are kept, while
    pages and fixed-name files (favicon, images) revalidate so a deploy shows."""
    if relative.parts[:2] == ("_next", "static"):
        return "public, max-age=31536000, immutable"
    if relative.parts[:1] == ("landing",):
        return "public, max-age=86400"
    return "no-cache"
