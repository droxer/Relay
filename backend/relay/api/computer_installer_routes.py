"""Public, immutable client downloads; never executes the client on the backend."""
from __future__ import annotations

import hashlib
import os
import re
import shlex
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse

from .helpers import backend_base_url

router = APIRouter()
ASSETS = Path(__file__).resolve().parents[1] / "computer"


def computer_setup_command(request: Request) -> str:
    """The whole browser-approved setup: the served script knows its own backend."""
    return f"curl -fsSL {shlex.quote(backend_base_url(request) + '/install.sh')} | sudo bash"


def computer_install_command(request: Request, node: dict[str, Any]) -> str:
    args = ["--sandbox-id", node["id"], "--employee-id", node["employeeId"], "--workspace", node["workspacePath"]]
    return f"{computer_setup_command(request)} -s -- {shlex.join(args)}"


def _bundle() -> tuple[Path, str]:
    path = Path(os.environ.get("RELAY_COMPUTER_BUNDLE", str(ASSETS / "daemon.tar.gz")))
    if not path.is_file():
        raise HTTPException(503, "Computer installer is not built. Run npm run build:computer before deploying.")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return path, digest


# `/computer/install.sh` is where commands copied before the root path point.
@router.get("/install.sh", include_in_schema=False)
@router.get("/computer/install.sh", include_in_schema=False)
def installer(request: Request) -> Response:
    _, digest = _bundle()
    origin = backend_base_url(request)
    source = (ASSETS / "install.sh").read_text()
    source = source.replace("@@BUNDLE_URL@@", shlex.quote(f"{origin}/computer/daemon-{digest}.tar.gz"))
    source = source.replace("@@BACKEND_URL@@", shlex.quote(origin))
    source = source.replace("@@BUNDLE_SHA256@@", digest)
    return Response(source, media_type="text/x-shellscript", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/computer/daemon-{digest}.tar.gz", include_in_schema=False)
def bundle(digest: str) -> FileResponse:
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise HTTPException(404, "Release not found.")
    path, actual = _bundle()
    if digest != actual:
        raise HTTPException(404, "Release changed. Copy and run the installation command again.")
    return FileResponse(path, media_type="application/gzip", headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})
