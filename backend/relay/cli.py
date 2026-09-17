from __future__ import annotations

import argparse
import json
import os

import uvicorn
from loguru import logger

from .app import create_app
from .core import deploy_config
from .core.environment import load_backend_env
from .core.logging_config import setup_logging
from .core.storage_config import database_url_from_env
from .persistence.employee_handle_backfill import plan_handles, summarize
from .persistence.session_import import migrate_local_sessions
from .persistence.session_store import DatabaseSessionStore

load_backend_env()


def rehearse_employee_handles(database_url: str) -> dict:
    """The employee-handle backfill plan for a live database, without writing."""
    from sqlalchemy import create_engine, text

    engine = create_engine(database_url)
    with engine.connect() as connection:
        employees = [
            dict(row)
            for row in connection.execute(
                text(
                    "SELECT id, display_name FROM employees "
                    "ORDER BY created_at, id"
                )
            ).mappings()
        ]
        usernames = {
            str(row["employee_id"]): row["username"]
            for row in connection.execute(
                text(
                    "SELECT employee_id, username FROM auth_users "
                    "WHERE employee_id IS NOT NULL"
                )
            ).mappings()
            if row["username"]
        }
    plan = plan_handles(employees, usernames)
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
            "migrate-local-sessions",
            "migrate-local-operational-state",
            "rehearse-employee-handles",
        ],
    )
    parser.add_argument("--host", default=deploy_config.bind_host())
    parser.add_argument("--port", type=int, default=deploy_config.bind_port())
    parser.add_argument("--data-dir", default=os.environ.get("RELAY_DATA_DIR"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    setup_logging()
    if args.command == "migrate-local-operational-state":
        from .persistence.operational_import import migrate_local_operational_state
        if not args.data_dir:
            parser.error("migrate-local-operational-state requires --data-dir")
        report = migrate_local_operational_state(args.data_dir,
            database_url_from_env(setting="migrate-local-operational-state"), dry_run=args.dry_run)
        print(json.dumps(report, indent=2))
        return
    if args.command == "migrate-local-sessions":
        if not args.data_dir:
            parser.error("migrate-local-sessions requires --data-dir")
        store = DatabaseSessionStore(
            database_url_from_env(setting="migrate-local-sessions")
        )
        store.verify_schema()
        report = migrate_local_sessions(args.data_dir, store, dry_run=args.dry_run)
        print(json.dumps(report, indent=2))
        if report["failures"]:
            raise SystemExit(1)
        return
    if args.command == "rehearse-employee-handles":
        # Reads only. Point it at a copy of production before running migration
        # 20260831_0065 for real: it prints the handle every employee would be
        # given, which source it came from, and every collision that had to be
        # suffixed — the questions a backfill can only answer against real data.
        report = rehearse_employee_handles(
            database_url_from_env(setting="rehearse-employee-handles")
        )
        print(json.dumps(report, indent=2))
        return
    app = create_app(args.data_dir) if args.data_dir else create_app()
    auth_store = app.state.auth_store
    if not auth_store.has_users():
        logger.info(
            "No users yet. Bootstrap the first admin via /api/v1/auth/bootstrap "
            "using the persisted admin token.",
        )
    logger.info("Relay backend listening on http://{}:{}", args.host, args.port)
    logger.info("Relay backend control panel: http://{}:{}/admin", args.host, args.port)
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
