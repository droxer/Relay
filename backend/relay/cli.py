from __future__ import annotations

import argparse
import asyncio
import json
import os

import uvicorn
from loguru import logger

from .app import create_app
from .core import deploy_config
from .core.environment import load_backend_env
from .core.logging_config import setup_logging
from .core.storage_config import database_url_from_env
from .persistence.blob_migration import migrate_blobs
from .persistence.blob_store import blob_store_from_env
from .persistence.database_backup import backup_database, backup_target_from_env
from .persistence.user_handle_backfill import plan_handles, summarize
from .persistence.session_import import migrate_local_sessions
from .persistence.session_store import DatabaseSessionStore
from .persistence.storage_report import storage_report

load_backend_env()


def rehearse_user_handles(database_url: str) -> dict:
    """The user-handle backfill plan for a live database, without writing."""
    from sqlalchemy import create_engine, text

    engine = create_engine(database_url)
    with engine.connect() as connection:
        users = [
            dict(row)
            for row in connection.execute(
                text(
                    "SELECT id, display_name FROM users "
                    "ORDER BY created_at, id"
                )
            ).mappings()
        ]
        usernames = {
            str(row["user_id"]): row["username"]
            for row in connection.execute(
                text(
                    "SELECT user_id, username FROM auth_accounts "
                    "WHERE user_id IS NOT NULL"
                )
            ).mappings()
            if row["username"]
        }
    plan = plan_handles(users, usernames)
    return {"plan": plan, **summarize(plan)}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="relay", description="Relay Python backend")
    parser.add_argument(
        "command",
        nargs="?",
        default="relay",
        choices=[
            "relay",
            "serve",
            "serve-with-worker",
            "worker",
            "worker-schema",
            "migrate-local-sessions",
            "migrate-local-operational-state",
            "migrate-blobs-to-r2",
            "backup-database",
            "rehearse-user-handles",
            "storage-report",
        ],
    )
    parser.add_argument("--host", default=deploy_config.bind_host())
    parser.add_argument("--port", type=int, default=deploy_config.bind_port())
    parser.add_argument("--data-dir", default=os.environ.get("RELAY_DATA_DIR"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    setup_logging()
    if args.command == "serve-with-worker":
        from .processes import serve_with_worker

        raise SystemExit(asyncio.run(serve_with_worker(
            host=args.host, port=args.port, data_dir=args.data_dir,
        )))
    if args.command in ("worker", "worker-schema"):
        from .background import apply_worker_schema, run_worker

        if args.command == "worker-schema":
            asyncio.run(apply_worker_schema())
        else:
            asyncio.run(run_worker(args.data_dir))
        return
    if args.command == "migrate-local-operational-state":
        from .persistence.operational_import import migrate_local_operational_state
        if not args.data_dir:
            parser.error("migrate-local-operational-state requires --data-dir")
        report = migrate_local_operational_state(args.data_dir,
            database_url_from_env(setting="migrate-local-operational-state"), dry_run=args.dry_run)
        print(json.dumps(report, indent=2))
        return
    if args.command == "backup-database":
        client, bucket = backup_target_from_env()
        report = backup_database(
            database_url_from_env(setting="backup-database"), client, bucket
        )
        print(json.dumps(report, indent=2))
        return
    if args.command == "migrate-blobs-to-r2":
        blob_store = blob_store_from_env()
        if blob_store is None:
            parser.error("migrate-blobs-to-r2 requires RELAY_BLOB_STORE=r2 and its R2 settings")
        # Without --data-dir only database bytes move; the data dir's skill
        # objects keep being copied up lazily as they are read.
        report = migrate_blobs(
            database_url_from_env(setting="migrate-blobs-to-r2"),
            blob_store,
            data_dir=args.data_dir,
            dry_run=args.dry_run,
        )
        print(json.dumps(report, indent=2))
        return
    if args.command == "migrate-local-sessions":
        if not args.data_dir:
            parser.error("migrate-local-sessions requires --data-dir")
        store = DatabaseSessionStore(
            database_url_from_env(setting="migrate-local-sessions"),
            blob_store=blob_store_from_env(),
        )
        store.verify_schema()
        report = migrate_local_sessions(args.data_dir, store, dry_run=args.dry_run)
        print(json.dumps(report, indent=2))
        if report["failures"]:
            raise SystemExit(1)
        return
    if args.command == "rehearse-user-handles":
        # Reads only. Point it at a copy of production before running migration
        # 20260831_0065 for real: it prints the handle every user would be
        # given, which source it came from, and every collision that had to be
        # suffixed — the questions a backfill can only answer against real data.
        report = rehearse_user_handles(
            database_url_from_env(setting="rehearse-user-handles")
        )
        print(json.dumps(report, indent=2))
        return
    if args.command == "storage-report":
        # Reads only: table sizes plus the bytes stored inline as artifact
        # snapshots, skill blobs, and profile images. See storage_report.py
        # for when that content should move to an object store.
        report = storage_report(database_url_from_env(setting="storage-report"))
        print(json.dumps(report, indent=2))
        return
    app = create_app(args.data_dir) if args.data_dir else create_app()
    auth_store = app.state.auth_store
    if not auth_store.has_accounts():
        logger.info(
            "No users yet. Bootstrap the first admin via /api/v1/auth/bootstrap "
            "using the persisted admin token.",
        )
    logger.info("Relay backend listening on http://{}:{}", args.host, args.port)
    logger.info("Relay backend Admin Console: http://{}:{}/admin", args.host, args.port)
    logger.info("Relay web UI: http://{}:{}/", args.host, args.port)
    trust_proxy = deploy_config.trust_proxy_headers()
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_config=None,
        # Behind a platform load balancer the socket peer is the edge, not the
        # client: without this every request reads as plain http from the
        # proxy's address, and session cookies would never be marked Secure.
        proxy_headers=trust_proxy,
        forwarded_allow_ips=(
            deploy_config.forwarded_allow_ips() if trust_proxy else None
        ),
    )
