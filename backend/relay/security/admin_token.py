"""The admin bearer token: seeding, verifying, and reissuing it."""

from __future__ import annotations

import os
from pathlib import Path

from loguru import logger

from ..persistence.org.admin_tokens import DatabaseAdminTokenStore

_admin_token_store: DatabaseAdminTokenStore | None = None

# Where the token lived before it moved to the database. Read once, imported
# as a hash, and deleted, so a container without a data volume loses nothing.
_LEGACY_ADMIN_TOKEN_FILE = Path("auth") / "admin-token"


def configure_admin_token(root_dir: str | Path, store: DatabaseAdminTokenStore) -> None:
    """Wire the admin-token store and seed it if it is empty.

    Called once from create_app. The stored hash is authoritative; a legacy
    token file is imported ahead of RELAY_ADMIN_TOKEN because it was the
    authoritative value before. With neither, nothing is generated: a token
    that only its hash remembers would be unrecoverable, so an admin issues one
    from the console instead.
    """
    global _admin_token_store
    _admin_token_store = store
    legacy = Path(root_dir) / _LEGACY_ADMIN_TOKEN_FILE
    if legacy.exists():
        persisted = legacy.read_text(encoding="utf-8").strip()
        if persisted and store.seed(persisted):
            logger.info("Admin token imported from the data directory into the database")
        try:
            legacy.unlink()
        except OSError as error:
            # The hash is already authoritative; a leftover file is inert.
            logger.warning("Could not remove the legacy admin token file", path=str(legacy), error=str(error))
    seed = os.environ.get("RELAY_ADMIN_TOKEN", "").strip()
    if seed and store.seed(seed):
        logger.info("Admin token seeded from RELAY_ADMIN_TOKEN")


def admin_token_configured() -> bool:
    return _admin_token_store is not None and _admin_token_store.is_configured()


def verify_admin_token(candidate: str | None) -> bool:
    """Whether ``candidate`` is the bearer token for bootstrap, supervisor,
    and admin API calls."""
    if not candidate or _admin_token_store is None:
        return False
    return _admin_token_store.verify(candidate)


def reissue_admin_token() -> str:
    """Rotate the admin token and return the new plaintext — the only time it
    is ever shown. The old value stops working immediately, including one
    seeded from RELAY_ADMIN_TOKEN."""
    if _admin_token_store is None:
        raise ValueError("Admin token store is not configured.")
    token = _admin_token_store.issue()
    logger.info("Admin token reissued")
    return token
