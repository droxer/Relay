"""Forgotten passwords: who a reset request reaches, and what they are sent.

Self-serve reset exists only while email can be delivered — a "forgot
password" link whose mail goes nowhere is a dead end. The admin path works
either way: it always returns the link, so an install without mail (or an
Account without an address) still has a way back in.

Public answers never reveal whether an Account exists: the request handler
schedules ``request`` to run after the response, and every dead token reads
the same. The store (``relay.security.password_resets``) keeps the records.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from loguru import logger

from ..core.deploy_config import public_backend_url, public_web_url
from ..notifications.mailer import DeliveryStatus, Mailer, NullMailer
from ..notifications.templates import password_changed_email, password_reset_email
from ..security.password_resets import (
    LiveReset,
    PasswordResetStore,
    ResetAccount,
    ResetNotLiveError,
    ResetThrottle,
    hash_reset_token,
    new_reset_token,
)
from .waitlist import MAX_EMAIL_LENGTH, SUPPORTED_LOCALES, normalize_email

DEFAULT_TTL_MINUTES = 30
MIN_TTL_MINUTES = 5
MAX_TTL_MINUTES = 24 * 60
DEFAULT_COOLDOWN_SECONDS = 60
DEFAULT_MAX_PER_HOUR = 5
# One shared address cannot fan a single request out into a flood of mail.
MAX_ACCOUNTS_PER_REQUEST = 3
_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,128}$")
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")

__all__ = [
    "AdminReset",
    "PasswordResetConfig",
    "PasswordResetService",
    "ResetNotLiveError",
    "normalize_reset_identifier",
    "password_reset_config_from_env",
    "reset_url",
]


def _default_throttle() -> ResetThrottle:
    return ResetThrottle(
        min_interval=timedelta(seconds=DEFAULT_COOLDOWN_SECONDS),
        max_per_hour=DEFAULT_MAX_PER_HOUR,
    )


@dataclass(frozen=True)
class PasswordResetConfig:
    ttl: timedelta = timedelta(minutes=DEFAULT_TTL_MINUTES)
    throttle: ResetThrottle = field(default_factory=_default_throttle)

    @property
    def ttl_minutes(self) -> int:
        return int(self.ttl.total_seconds() // 60)


@dataclass(frozen=True)
class AdminReset:
    url: str
    expires_at: datetime
    delivery: DeliveryStatus


def password_reset_config_from_env() -> PasswordResetConfig:
    ttl = min(
        MAX_TTL_MINUTES,
        max(MIN_TTL_MINUTES, _int_env("RELAY_PASSWORD_RESET_TTL_MINUTES", DEFAULT_TTL_MINUTES)),
    )
    cooldown = max(0, _int_env("RELAY_PASSWORD_RESET_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_SECONDS))
    per_hour = max(1, _int_env("RELAY_PASSWORD_RESET_MAX_PER_HOUR", DEFAULT_MAX_PER_HOUR))
    return PasswordResetConfig(
        ttl=timedelta(minutes=ttl),
        throttle=ResetThrottle(min_interval=timedelta(seconds=cooldown), max_per_hour=per_hour),
    )


def normalize_reset_identifier(value: Any) -> str:
    """A username (lowercased, as login matches it) or a normalized email."""
    identifier = value.strip().lower() if isinstance(value, str) else ""
    if (
        not identifier
        or len(identifier) > MAX_EMAIL_LENGTH
        or _CONTROL_CHARACTERS.search(identifier)
    ):
        raise ValueError("Enter your username or email.")
    return normalize_email(identifier) if "@" in identifier else identifier


def trusted_web_origin() -> str | None:
    """The configured public origin an emailed link may point at.

    Never the request's Host header: anyone can send a request with a forged
    Host, and the mail it triggers would carry a genuine-looking link to their
    site — with a live token in it."""
    return public_web_url() or public_backend_url()


def reset_url(web_origin: str, token: str) -> str:
    # The token rides in the fragment, which browsers never send to a server,
    # so it stays out of every access log and every Referer header.
    return f"{web_origin.rstrip('/')}/reset-password#token={token}"


class PasswordResetService:
    def __init__(
        self,
        store: PasswordResetStore,
        mailer: Mailer,
        *,
        config: PasswordResetConfig | None = None,
        clock: Callable[[], datetime] | None = None,
    ):
        self.store = store
        self.mailer = mailer
        self.config = config or PasswordResetConfig()
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    @property
    def self_serve_enabled(self) -> bool:
        """Mail can be sent, and there is a configured origin to link to."""
        return not isinstance(self.mailer, NullMailer) and trusted_web_origin() is not None

    # --- public -------------------------------------------------------------

    def request(self, identifier: str, *, locale: str | None, web_origin: str) -> None:
        """Send a link to every Account ``identifier`` names. Runs after the
        response is sent, so its cost cannot reveal whether any matched."""
        for account in self.store.accounts_for(identifier)[:MAX_ACCOUNTS_PER_REQUEST]:
            if not account.email:
                logger.info("Password reset skipped: no address", account_id=account.account_id)
                continue
            issued = self._issue(account, web_origin, throttle=self.config.throttle)
            if issued is None:
                logger.info("Password reset throttled", account_id=account.account_id)
                continue
            self._send_link(account, issued[0], locale)

    def lookup(self, token: str) -> LiveReset:
        live = self.store.peek(self._token_hash(token), now=self._clock())
        if live is None:
            raise ResetNotLiveError
        return live

    def complete(self, token: str, password: str) -> ResetAccount:
        """Set the password and sign the Account out everywhere.

        Raises ``ResetNotLiveError`` for a dead link and ``ValueError`` (the
        password policy) for a refused password, which leaves the link live."""
        account = self.store.complete(self._token_hash(token), password, now=self._clock())
        logger.info("Password reset completed", account_id=account.account_id)
        return account

    def send_changed_notice(self, account: ResetAccount) -> None:
        if not account.email:
            return
        changed_at = self._clock().strftime("%Y-%m-%d %H:%M UTC")
        result = self.mailer.send(
            password_changed_email(
                to=account.email,
                username=account.username,
                changed_at=changed_at,
                locale=_locale(account, None),
            )
        )
        if result.status not in ("sent", "skipped"):
            logger.warning(
                "Password change notice not delivered",
                account_id=account.account_id,
                status=result.status,
            )

    # --- admin --------------------------------------------------------------

    def admin_issue(self, user_id: str, *, web_origin: str) -> AdminReset:
        """Issue a link for a User's Account, bypassing the request throttle.

        The link comes back to the admin whether or not it could be emailed."""
        account = self.store.account_for_user(user_id)
        if account is None:
            raise KeyError(user_id)
        issued = self._issue(account, web_origin, throttle=None)
        if issued is None:  # Only a throttle refuses, and this path has none.
            raise RuntimeError("Password reset was not issued.")
        url, expires_at = issued
        delivery: DeliveryStatus = "skipped"
        if account.email:
            delivery = self._send_link(account, url, None)
        logger.info("Password reset issued by an admin", account_id=account.account_id)
        return AdminReset(url=url, expires_at=expires_at, delivery=delivery)

    # --- internals ----------------------------------------------------------

    def _issue(
        self, account: ResetAccount, web_origin: str, *, throttle: ResetThrottle | None
    ) -> tuple[str, datetime] | None:
        now = self._clock()
        expires_at = now + self.config.ttl
        token = new_reset_token()
        if not self.store.issue(
            account.account_id,
            hash_reset_token(token),
            now=now,
            expires_at=expires_at,
            throttle=throttle,
        ):
            return None
        logger.info("Password reset issued", account_id=account.account_id)
        return reset_url(web_origin, token), expires_at

    def _send_link(self, account: ResetAccount, url: str, locale: str | None) -> DeliveryStatus:
        if not account.email:
            return "skipped"
        result = self.mailer.send(
            password_reset_email(
                to=account.email,
                username=account.username,
                reset_url=url,
                expires_in_minutes=self.config.ttl_minutes,
                locale=_locale(account, locale),
            )
        )
        if result.status not in ("sent", "skipped"):
            logger.warning(
                "Password reset email not delivered",
                account_id=account.account_id,
                status=result.status,
            )
        return result.status

    @staticmethod
    def _token_hash(token: str) -> str:
        if not _TOKEN_PATTERN.match(token or ""):
            raise ResetNotLiveError
        return hash_reset_token(token)


def _locale(account: ResetAccount, requested: str | None) -> str:
    """The Account's own language, else the page it asked from, else English."""
    if account.language in SUPPORTED_LOCALES:
        return account.language
    return requested if requested in SUPPORTED_LOCALES else "en"


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip())
    except ValueError:
        return default
