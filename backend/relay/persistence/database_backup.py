"""Nightly logical backups of the Relay database into an R2 bucket.

``relay backup-database`` runs ``pg_dump --format=custom`` into a temporary
file, proves the archive is readable with ``pg_restore --list``, and only then
uploads it — a failed or truncated dump never replaces anything in the
bucket. Each run writes ``daily/relay-<UTC timestamp>.dump``; a run on the
first of the month also copies it to ``monthly/``. Retention is two R2
lifecycle rules on those prefixes, not code.

Connection details reach pg_dump through ``PG*`` environment variables so the
password never appears in a process listing or an error message.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger
from sqlalchemy.engine import make_url

from . import blob_store

Runner = Callable[..., subprocess.CompletedProcess]

_ARCHIVE_CONTENT_TYPE = "application/octet-stream"


def pg_env_from_url(database_url: str) -> dict[str, str]:
    url = make_url(database_url)
    if not url.drivername.startswith("postgresql"):
        raise RuntimeError("relay backup-database needs a Postgres database URL.")
    env = {
        "PGHOST": url.host or "",
        "PGPORT": str(url.port or 5432),
        "PGUSER": url.username or "",
        "PGPASSWORD": url.password or "",
        "PGDATABASE": url.database or "",
    }
    sslmode = url.query.get("sslmode")
    if sslmode:
        env["PGSSLMODE"] = str(sslmode)
    return {name: value for name, value in env.items() if value}


def backup_keys(now: datetime) -> tuple[str, str | None]:
    name = f"relay-{now.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}.dump"
    return f"daily/{name}", (f"monthly/{name}" if now.astimezone(timezone.utc).day == 1 else None)


def backup_database(
    database_url: str,
    client: Any,
    bucket: str,
    *,
    now: datetime | None = None,
    run: Runner = subprocess.run,
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    daily_key, monthly_key = backup_keys(now)
    env = {**os.environ, **pg_env_from_url(database_url)}
    with tempfile.TemporaryDirectory(prefix="relay-backup-") as scratch:
        archive = Path(scratch) / "relay.dump"
        _check(
            run(
                ["pg_dump", "--format=custom", "--no-owner", "--no-privileges", f"--file={archive}"],
                env=env, capture_output=True, text=True, check=False,
            ),
            "pg_dump failed",
        )
        size = archive.stat().st_size if archive.exists() else 0
        if size == 0:
            raise RuntimeError("pg_dump produced an empty archive; nothing was uploaded.")
        _check(
            run(["pg_restore", "--list", str(archive)], env=env, capture_output=True, text=True, check=False),
            "pg_restore could not read the archive",
        )
        # upload_file switches to multipart for large archives.
        client.upload_file(str(archive), bucket, daily_key, ExtraArgs={"ContentType": _ARCHIVE_CONTENT_TYPE})
    if monthly_key:
        client.copy_object(Bucket=bucket, Key=monthly_key, CopySource={"Bucket": bucket, "Key": daily_key})
    report = {"bucket": bucket, "key": daily_key, "monthlyKey": monthly_key, "bytes": size}
    logger.info("Database backup uploaded", **report)
    return report


def _check(result: subprocess.CompletedProcess, message: str) -> None:
    if result.returncode == 0:
        return
    # pg_dump's stderr names the host and database, never the password (it
    # came from PGPASSWORD); keep only its tail for the operator.
    detail = (result.stderr or "").strip().splitlines()[-1:] or [f"exit {result.returncode}"]
    raise RuntimeError(f"{message}: {detail[0]}; nothing was uploaded.")


def backup_target_from_env() -> tuple[Any, str]:
    """The R2 client and bucket for backups.

    A dedicated token (``RELAY_BACKUP_R2_*``) is preferred so the backup bucket
    is not writable by the backend's everyday credentials; the shared
    ``RELAY_R2_*`` keys are the fallback.
    """
    bucket = os.environ.get("RELAY_BACKUP_R2_BUCKET", "").strip()
    account = os.environ.get("RELAY_R2_ACCOUNT_ID", "").strip()
    access_key = (
        os.environ.get("RELAY_BACKUP_R2_ACCESS_KEY_ID", "").strip()
        or os.environ.get("RELAY_R2_ACCESS_KEY_ID", "").strip()
    )
    secret = (
        os.environ.get("RELAY_BACKUP_R2_SECRET_ACCESS_KEY", "").strip()
        or os.environ.get("RELAY_R2_SECRET_ACCESS_KEY", "").strip()
    )
    missing = [
        name
        for name, value in (
            ("RELAY_BACKUP_R2_BUCKET", bucket),
            ("RELAY_R2_ACCOUNT_ID", account),
            ("RELAY_BACKUP_R2_ACCESS_KEY_ID (or RELAY_R2_ACCESS_KEY_ID)", access_key),
            ("RELAY_BACKUP_R2_SECRET_ACCESS_KEY (or RELAY_R2_SECRET_ACCESS_KEY)", secret),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(f"relay backup-database requires {', '.join(missing)}.")
    client = blob_store.r2_client(account_id=account, access_key_id=access_key, secret_access_key=secret)
    return client, bucket
