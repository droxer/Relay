"""Public, immutable client downloads; never executes the client on the backend."""
from __future__ import annotations

import hashlib
import json
import re
import shlex
import tarfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from loguru import logger

from ...core.deploy_config import public_web_url
from ...core.daemon_capabilities import DAEMON_NODE_CAPABILITIES
from .node_install import backend_base_url
from ..deps import app_context

router = APIRouter()
ASSETS = Path(__file__).resolve().parents[2] / "computer"
BUNDLE_MANIFEST = "node_modules/relay-daemon/capabilities.json"


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


def _bundle(request: Request) -> tuple[Path, str]:
    path = bundle_path(app_context(request).settings.computer_bundle)
    if not path.is_file():
        raise HTTPException(503, "Computer installer is not built. Run npm run build:computer before deploying.")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return path, digest


def bundle_path(configured: Path | None) -> Path:
    """``RELAY_COMPUTER_BUNDLE`` (``AppSettings.computer_bundle``), else the built-in one."""
    return configured or ASSETS / "daemon.tar.gz"


def bundle_missing_capabilities(path: Path) -> list[str] | None:
    """Capabilities this backend requires that the bundled daemon lacks.

    Every computer installed or updated from a bundle missing one reads as
    outdated forever, so the backend checks at startup. ``None`` means the
    bundle records no manifest (built before it did) and cannot be checked.
    """
    try:
        with tarfile.open(path, "r:gz") as archive:
            member = archive.extractfile(BUNDLE_MANIFEST)
            manifest = json.load(member) if member else None
    except KeyError:
        return None
    advertised = set((manifest if isinstance(manifest, dict) else {}).get("capabilities") or [])
    return sorted(DAEMON_NODE_CAPABILITIES - advertised)


def warn_if_bundle_stale(configured: Path | None) -> None:
    """Log, never fail: a backend without a usable bundle still serves everything else."""
    path = bundle_path(configured)
    if not path.is_file():
        return
    # The log format prints only the message, so the details go in it.
    try:
        missing = bundle_missing_capabilities(path)
    except (OSError, tarfile.TarError, ValueError) as error:
        logger.warning("Computer installer bundle {} is unreadable: {}", path, error)
        return
    if missing is None:
        logger.warning(
            "Computer installer bundle {} predates this backend; run `npm run build:computer`", path,
        )
    elif missing:
        logger.warning(
            "Computer installer bundle {} lacks {}; computers it installs or updates will read "
            "as outdated. Run `npm run build:computer`",
            path,
            ", ".join(missing),
        )


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
    _, digest = _bundle(request)
    source = _render("install.sh", backend_base_url(request), digest, shlex.quote)
    return Response(source, media_type="text/x-shellscript", headers=_NO_STORE)


# text/plain with a charset, so `irm` hands PowerShell a string rather than bytes.
@router.get("/install.ps1", include_in_schema=False)
@router.get("/computer/install.ps1", include_in_schema=False)
def windows_installer(request: Request) -> Response:
    _, digest = _bundle(request)
    source = _render("install.ps1", backend_base_url(request), digest, powershell_literal)
    return Response(source, media_type="text/plain; charset=utf-8", headers=_NO_STORE)


# The edge caches these paths, so a miss must say no-store: during a rollover an
# old instance answers for the new digest, and a cached 404 would outlive it.
@router.get("/computer/daemon-{digest}.tar.gz", include_in_schema=False)
def bundle(request: Request, digest: str) -> FileResponse:
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise HTTPException(404, "Release not found.", headers=_NO_STORE)
    path, actual = _bundle(request)
    if digest != actual:
        raise HTTPException(404, "Release changed. Copy and run the installation command again.", headers=_NO_STORE)
    return FileResponse(path, media_type="application/gzip", headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})
