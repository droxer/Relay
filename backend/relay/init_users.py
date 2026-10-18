from __future__ import annotations

import argparse
import os
import sys

from .bootstrap.stores import retired_settings_chose_database_accounts
from .core.environment import load_backend_env
from .core.storage_config import database_url_from_env
from .persistence.stores import DEFAULT_RELAY_DATA_DIR
from .security.auth import auth_store_from_env
from .security.auth_file_import import (
    accounts_imported,
    legacy_accounts_present,
    migrate_legacy_accounts,
)


def main(argv: list[str] | None = None) -> int:
    load_backend_env()
    parser = argparse.ArgumentParser(
        prog="python -m relay.init_users", description="Create an initial Relay user."
    )
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("RELAY_DATA_DIR") or str(DEFAULT_RELAY_DATA_DIR),
        help="Data directory whose retired account files are imported first.",
    )
    parser.add_argument("--username", default="admin")
    parser.add_argument(
        "--password",
        default=os.environ.get("RELAY_INITIAL_ADMIN_PASSWORD"),
        help="Initial password (or set RELAY_INITIAL_ADMIN_PASSWORD).",
    )
    parser.add_argument("--role", choices=["admin", "user"], default="admin")
    parser.add_argument("--email", default=None)
    # --employee-id is the pre-rename spelling of the same flag.
    parser.add_argument("--user-id", "--employee-id", dest="user_id", default=None)
    parser.add_argument("--department-id", default="administration")
    parser.add_argument("--department-name", default="Administration")
    parser.add_argument(
        "--only-if-empty",
        action="store_true",
        help="Skip creation when any user already exists.",
    )
    args = parser.parse_args(argv)
    if not args.password:
        parser.error("--password is required (or set RELAY_INITIAL_ADMIN_PASSWORD).")

    store = auth_store_from_env()
    # An install still holding the retired account files gets them imported
    # first, so "--only-if-empty" sees them and a new admin cannot take a
    # username the import would then refuse as a conflict.
    database_url = database_url_from_env(setting="relay.init_users")
    if legacy_accounts_present(args.data_dir) and not accounts_imported(
        args.data_dir, database_url
    ):
        try:
            migrate_legacy_accounts(
                args.data_dir,
                database_url,
                accounts_already_in_database=retired_settings_chose_database_accounts(),
            )
        except ValueError as error:
            print(f"Failed to import existing accounts: {error}", file=sys.stderr)
            return 1
    if args.only_if_empty and store.has_accounts():
        print("Users already exist; skipped.")
        return 0

    try:
        account = store.create_account(
            args.username,
            args.password,
            role=args.role,
            email=args.email,
            user_id=args.user_id or args.username,
            department_id=args.department_id,
            department_name=args.department_name,
        )
    except ValueError as error:
        print(f"Failed to create user: {error}", file=sys.stderr)
        return 1

    print(f"Created {account['role']} user {account['username']}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
