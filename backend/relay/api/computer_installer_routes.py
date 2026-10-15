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

from ..core.deploy_config import public_web_url
from .helpers import backend_base_url

router = APIRouter()
ASSETS = Path(__file__).resolve().parents[1] / "computer"


def computer_setup_command(request: Request) -> str:
    """The whole browser-approved setup: the served script knows its own backend.

    It names the web origin people already know; that host hands /install.sh to
    the API. No sudo: Relay installs for the current account, never as root.
    """
    origin = public_web_url() or backend_base_url(request)
    return f"curl -fsSL {shlex.quote(origin + '/install.sh')} | bash"


def _install_args(node: dict[str, Any]) -> list[str]:
    return ["--sandbox-id", node["id"], "--user-id", node["userId"], "--workspace", node["workspacePath"]]


def computer_install_command(request: Request, node: dict[str, Any]) -> str:
    return f"{computer_setup_command(request)} -s -- {shlex.join(_install_args(node))}"


def powershell_literal(value: str) -> str:
    """A single-quoted PowerShell string: nothing inside is expanded."""
    return "'" + value.replace("'", "''") + "'"


def _windows_installer_url(request: Request) -> str:
    return backend_base_url(request) + "/install.ps1"


def computer_windows_setup_command(request: Request) -> str:
    """The PowerShell twin of `computer_setup_command`; it needs no elevation."""
    return f"irm {powershell_literal(_windows_installer_url(request))} | iex"


def computer_windows_install_command(request: Request, node: dict[str, Any]) -> str:
    # Quoted arguments, because PowerShell would read a bare `--sandbox-id` as a parameter name.
    args = " ".join(powershell_literal(arg) for arg in _install_args(node))
    return f"& ([scriptblock]::Create((irm {powershell_literal(_windows_installer_url(request))}))) {args}"


def _bundle() -> tuple[Path, str]:
    path = Path(os.environ.get("RELAY_COMPUTER_BUNDLE", str(ASSETS / "daemon.tar.gz")))
    if not path.is_file():
        raise HTTPException(503, "Computer installer is not built. Run npm run build:computer before deploying.")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return path, digest


def _render(template: str, origin: str, digest: str, quote: Any) -> str:
    source = (ASSETS / template).read_text()
    source = source.replace("@@BUNDLE_URL@@", quote(f"{origin}/computer/daemon-{digest}.tar.gz"))
    source = source.replace("@@BACKEND_URL@@", quote(origin))
    return source.replace("@@BUNDLE_SHA256@@", digest)


_NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


# `/computer/install.sh` is where commands copied before the root path point.
@router.get("/install.sh", include_in_schema=False)
@router.get("/computer/install.sh", include_in_schema=False)
def installer(request: Request) -> Response:
    _, digest = _bundle()
    source = _render("install.sh", backend_base_url(request), digest, shlex.quote)
    return Response(source, media_type="text/x-shellscript", headers=_NO_STORE)


# text/plain with a charset, so `irm` hands PowerShell a string rather than bytes.
@router.get("/install.ps1", include_in_schema=False)
@router.get("/computer/install.ps1", include_in_schema=False)
def windows_installer(request: Request) -> Response:
    _, digest = _bundle()
    source = _render("install.ps1", backend_base_url(request), digest, powershell_literal)
    return Response(source, media_type="text/plain; charset=utf-8", headers=_NO_STORE)


# The edge caches these paths, so a miss must say no-store: during a rollover an
# old instance answers for the new digest, and a cached 404 would outlive it.
@router.get("/computer/daemon-{digest}.tar.gz", include_in_schema=False)
def bundle(digest: str) -> FileResponse:
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise HTTPException(404, "Release not found.", headers=_NO_STORE)
    path, actual = _bundle()
    if digest != actual:
        raise HTTPException(404, "Release changed. Copy and run the installation command again.", headers=_NO_STORE)
    return FileResponse(path, media_type="application/gzip", headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})
