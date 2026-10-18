"""The waitlist's rules: who may join, be invited, decline, and accept.

This is the one place that decides a waitlist transition. Routes parse,
authorize, and delegate; the store applies the conditional writes. Email goes
through the injected ``Mailer`` and never decides an outcome — a failed send
leaves the entry invited, and the admin still gets the link.

An invite reaches a person two ways: an admin invites someone who asked
(``invite``, ``invite_batch``), or invites an address directly
(``invite_email``). Only the public join depends on ``RELAY_WAITLIST_ENABLED``;
inviting works on every install.
"""

from __future__ import annotations

import builtins
import hashlib
import os
import re
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, UTC
from typing import Any

from loguru import logger

from ..notifications.mailer import DeliveryResult, Mailer, NullMailer
from ..notifications.templates import confirmation_email, invite_email
from ..persistence.store_common import _parse_iso
from ..persistence.waitlist_store import (
    ADMIN_INVITE_SOURCE,
    WaitlistConflictError,
    WaitlistFullError as WaitlistFullError,
)

MAX_EMAIL_LENGTH = 254
FIELD_LIMITS = {"name": 120, "company": 120, "role": 80, "useCase": 1000}
MAX_SOURCE_LENGTH = 120
MAX_NOTE_LENGTH = 1000
MAX_BATCH_INVITES = 50
SUPPORTED_LOCALES = ("en", "zh-CN")
DEFAULT_INVITE_TTL_DAYS = 14
DEFAULT_MAX_WAITING = 10_000
_TOKEN_BYTES = 32
# Each part excludes whitespace, control characters, and the characters that
# would let one "address" smuggle a display name or a second recipient into
# the provider's `to` field.
_EMAIL_PART = r'[^@\s,;<>()"\\\x00-\x1f\x7f]+'
_EMAIL_PATTERN = re.compile(rf"^{_EMAIL_PART}@{_EMAIL_PART}\.{_EMAIL_PART}$")
# Postgres text cannot hold NUL, and no field here needs a control character
# beyond the line breaks a multi-line answer may carry.
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,128}$")
_COLUMN_FOR_FIELD = {"name": "name", "company": "company", "role": "role", "useCase": "use_case"}


class WaitlistValidationError(ValueError):
    """Malformed public input (answered 400)."""


class InviteNotLiveError(LookupError):
    """Unknown, rotated, expired, or already used token (answered 404)."""


@dataclass(frozen=True)
class InviteOrigin:
    """Where an invite link points, and whether that link may be emailed.

    Only a configured public origin is ``trusted``. Without one the link is
    built on the request's own origin, which the admin sees before handing it
    over, but it is never mailed: a forged Host would put a live token in a
    genuine-looking email to someone else's site."""

    url: str
    trusted: bool


@dataclass(frozen=True)
class PendingInvite:
    """An issued invite whose email has not been sent yet."""

    entry_id: str
    email: str
    name: str | None
    locale: str | None
    url: str
    expires_on: str
    token_hash: str
    emailable: bool


@dataclass(frozen=True)
class WaitlistConfig:
    invite_ttl: timedelta = timedelta(days=DEFAULT_INVITE_TTL_DAYS)
    max_waiting: int = DEFAULT_MAX_WAITING
    confirmation_email: bool = True


def waitlist_config_from_env() -> WaitlistConfig:
    return WaitlistConfig(
        invite_ttl=timedelta(days=_positive_env("RELAY_WAITLIST_INVITE_TTL_DAYS", DEFAULT_INVITE_TTL_DAYS)),
        max_waiting=_positive_env("RELAY_WAITLIST_MAX_WAITING", DEFAULT_MAX_WAITING),
        confirmation_email=os.environ.get("RELAY_WAITLIST_CONFIRMATION_EMAIL", "1").strip().lower()
        not in ("0", "false", "no", "off"),
    )


def hash_invite_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_email(value: Any) -> str:
    email = value.strip().lower() if isinstance(value, str) else ""
    if not email or len(email) > MAX_EMAIL_LENGTH or not _EMAIL_PATTERN.match(email):
        raise WaitlistValidationError("Enter a valid email address.")
    return email


def join_fields(body: dict[str, Any]) -> dict[str, Any]:
    """The columns a public join request may set, validated."""
    fields: dict[str, Any] = {"email": normalize_email(body.get("email"))}
    for field, limit in FIELD_LIMITS.items():
        fields[_COLUMN_FOR_FIELD[field]] = _bounded_text(body.get(field), field, limit)
    # The source is filled in by the page, not typed, so it is cleaned and
    # clipped rather than rejected: a long referrer must not cost a signup.
    raw_source = body.get("source")
    source = _optional_text(_CONTROL_CHARACTERS.sub("", raw_source) if isinstance(raw_source, str) else None)
    fields["source"] = source[:MAX_SOURCE_LENGTH] if source else None
    locale = body.get("locale")
    fields["locale"] = locale if locale in SUPPORTED_LOCALES else None
    return fields


def invitee_fields(body: dict[str, Any]) -> dict[str, Any]:
    """The columns an admin's invite-by-email request may set, validated."""
    locale = body.get("locale")
    return {
        "email": normalize_email(body.get("email")),
        "name": _bounded_text(body.get("name"), "name", FIELD_LIMITS["name"]),
        "locale": locale if locale in SUPPORTED_LOCALES else None,
        "source": ADMIN_INVITE_SOURCE,
    }


def invite_url(web_origin: str, token: str) -> str:
    # The token rides in the fragment, which browsers never send to a server,
    # so it stays out of the Worker's, the edge's, and the backend's logs.
    return f"{web_origin.rstrip('/')}/join#token={token}"


class WaitlistService:
    def __init__(
        self,
        store: Any,
        mailer: Mailer,
        *,
        config: WaitlistConfig | None = None,
        clock: Callable[[], datetime] | None = None,
    ):
        self.store = store
        self.mailer = mailer
        self.config = config or WaitlistConfig()
        self._clock = clock or (lambda: datetime.now(UTC))

    @property
    def mail_configured(self) -> bool:
        """Whether an invite can go out by email at all; without it the admin
        copies each link by hand."""
        return not isinstance(self.mailer, NullMailer)

    # --- public -------------------------------------------------------------

    def join(self, body: dict[str, Any]) -> dict[str, Any] | None:
        """Record a join request. Returns the new entry, or None when nothing
        new was written (a resubmission or a honeypot hit) — the caller answers
        both the same way."""
        fields = join_fields(body)
        if _optional_text(body.get("website")):
            logger.info("Waitlist honeypot tripped")
            return None
        entry, created = self.store.join(fields, self._clock(), max_waiting=self.config.max_waiting)
        return entry if created else None

    def send_confirmation(self, entry: dict[str, Any]) -> None:
        """Tell a new entry they are on the list. Called after the response is
        sent, so a slow mail service cannot reveal whether an email was new."""
        if not self.config.confirmation_email:
            return
        result = self.mailer.send(confirmation_email(to=entry["email"], locale=entry.get("locale")))
        if result.status not in ("sent", "skipped"):
            logger.warning("Waitlist confirmation not delivered", status=result.status, error=result.error)

    def live_invite(self, token: str) -> dict[str, Any]:
        if not _TOKEN_PATTERN.match(token or ""):
            raise InviteNotLiveError()
        entry = self.store.find_by_token_hash(hash_invite_token(token))
        if not entry or not self._invite_is_live(entry):
            raise InviteNotLiveError()
        return entry

    def accept(
        self, token: str, create_account: Callable[[dict[str, Any]], dict[str, Any]]
    ) -> dict[str, Any]:
        """Redeem an invite by creating its account.

        The invite is claimed first with one conditional update, so two
        concurrent accepts cannot both create an account. If creating the
        account fails (weak password, taken handle) the claim is released and
        the link keeps working. The account exists before the entry is linked
        to it, so a failure while linking must not turn a signup into a 500."""
        if not _TOKEN_PATTERN.match(token or ""):
            raise InviteNotLiveError()
        token_hash = hash_invite_token(token)
        entry = self.store.claim_invite(token_hash, self._clock())
        if entry is None:
            raise InviteNotLiveError()
        try:
            account = create_account(entry)
        except Exception:
            self.store.release_claim(entry["id"], token_hash, self._clock())
            raise
        try:
            self.store.link_account(entry["id"], account["id"], self._clock())
        except Exception as error:  # noqa: BLE001 - linking is bookkeeping
            logger.warning(
                "Waitlist entry not linked to its new account",
                entry_id=entry["id"],
                account_id=account["id"],
                error=type(error).__name__,
            )
        logger.info("Waitlist invite accepted", entry_id=entry["id"], account_id=account["id"])
        return account

    # --- admin --------------------------------------------------------------

    def list(
        self, *, status: str | None, query: str | None, limit: int, offset: int
    ) -> dict[str, Any]:
        entries, total = self.store.list(status=status, query=query, limit=limit, offset=offset)
        return {
            "entries": [self.public_entry(entry) for entry in entries],
            "total": total,
            "counts": self.store.counts(),
        }

    def invite(self, entry_id: str, *, invited_by: str | None, origin: InviteOrigin) -> dict[str, Any]:
        """Invite one entry and email it now, so the admin sees the outcome."""
        pending = self._issue_invite(entry_id, invited_by=invited_by, origin=origin)
        result = self._deliver(pending)
        entry = self.store.record_delivery(entry_id, status=result.status, error=result.error, now=self._clock())
        return {"entry": self.public_entry(entry), "inviteUrl": pending.url, "delivery": _delivery(result)}

    def invite_email(
        self,
        body: dict[str, Any],
        *,
        invited_by: str | None,
        origin: InviteOrigin,
        email_in_use: Callable[[str], bool],
        account_live: Callable[[str], bool],
    ) -> dict[str, Any]:
        """Invite an address that never asked: the admin's own invitation.

        The address gets (or reuses) its entry, so a person who already asked
        is invited in place rather than twice. An address a live Account holds
        is refused — that person signs in, or resets their password. A joined
        entry whose account has since been deleted is reopened and invited
        again; any other joined entry is refused like any re-invite."""
        fields = invitee_fields(body)
        if email_in_use(fields["email"]):
            raise WaitlistConflictError("An account already uses this email.")
        entry = self.store.admit_invitee(fields, self._clock())
        account_id = entry.get("accountId")
        if entry["status"] == "joined" and account_id and not account_live(account_id):
            entry = self.store.reopen_departed(entry["id"], account_id, self._clock())
            logger.info("Waitlist entry reopened: its account was deleted", entry_id=entry["id"])
        return self.invite(entry["id"], invited_by=invited_by, origin=origin)

    def invite_batch(
        self,
        *,
        count: int | None,
        ids: builtins.list[str] | None,
        invited_by: str | None,
        origin: InviteOrigin,
    ) -> tuple[builtins.list[dict[str, Any]], builtins.list[PendingInvite]]:
        """Issue a batch of invites without sending them.

        Returns the admin's one-time links plus the sends still owed. The
        caller delivers those after responding: fifty slow sends inside the
        request could outlive the edge timeout and lose every link."""
        if ids is None:
            if count is None or count < 1 or count > MAX_BATCH_INVITES:
                raise WaitlistValidationError(f"count must be between 1 and {MAX_BATCH_INVITES}.")
            ids = self.store.oldest_waiting_ids(count)
        elif len(ids) > MAX_BATCH_INVITES:
            raise WaitlistValidationError(f"At most {MAX_BATCH_INVITES} entries can be invited at once.")
        invites: list[dict[str, Any]] = []
        pending: list[PendingInvite] = []
        # De-duplicated, so one request never mints a link it then kills.
        for entry_id in dict.fromkeys(ids):
            try:
                issued = self._issue_invite(entry_id, invited_by=invited_by, origin=origin)
            except (KeyError, WaitlistConflictError):
                continue
            # Nothing is queued when nothing will be sent: the link is the
            # whole invite, and the row says so at once.
            delivery = {"status": "queued", "error": None} if issued.emailable else _delivery(_unsent(issued))
            entry = self.store.record_delivery(
                entry_id, status=delivery["status"], error=delivery["error"], now=self._clock()
            )
            invites.append({"entry": self.public_entry(entry), "inviteUrl": issued.url, "delivery": delivery})
            pending.append(issued)
        return invites, pending

    def deliver_invites(self, pending: builtins.list[PendingInvite]) -> None:
        """Send queued invites one recipient at a time, recording each result.

        An entry re-invited, declined, or accepted since its link was issued is
        skipped: its queued email would carry a dead link, and its row already
        records what replaced it."""
        for issued in pending:
            if not issued.emailable:
                continue
            current = self.store.get(issued.entry_id)
            if current is None or current.get("inviteTokenHash") != issued.token_hash:
                continue
            result = self._deliver(issued)
            try:
                self.store.record_delivery(
                    issued.entry_id, status=result.status, error=result.error, now=self._clock()
                )
            except KeyError:
                continue  # Erased while its email was in flight.

    def _issue_invite(self, entry_id: str, *, invited_by: str | None, origin: InviteOrigin) -> PendingInvite:
        token = secrets.token_urlsafe(_TOKEN_BYTES)
        token_hash = hash_invite_token(token)
        now = self._clock()
        expires_at = now + self.config.invite_ttl
        entry = self.store.set_invite(
            entry_id,
            token_hash=token_hash,
            expires_at=expires_at,
            invited_by_user_id=invited_by,
            now=now,
        )
        logger.info("Waitlist entry invited", entry_id=entry_id)
        return PendingInvite(
            entry_id=entry_id,
            email=entry["email"],
            name=entry.get("name"),
            locale=entry.get("locale"),
            url=invite_url(origin.url, token),
            expires_on=expires_at.date().isoformat(),
            token_hash=token_hash,
            emailable=origin.trusted,
        )

    def _deliver(self, issued: PendingInvite) -> DeliveryResult:
        if not issued.emailable:
            return _unsent(issued)
        result = self.mailer.send(
            invite_email(
                to=issued.email,
                name=issued.name,
                invite_url=issued.url,
                expires_on=issued.expires_on,
                locale=issued.locale,
            )
        )
        if result.status not in ("sent", "skipped"):
            logger.warning("Waitlist invite not delivered", entry_id=issued.entry_id, status=result.status)
        return result

    def decline(self, entry_id: str) -> dict[str, Any]:
        return self.public_entry(self.store.decline(entry_id, self._clock()))

    def set_note(self, entry_id: str, note: Any) -> dict[str, Any]:
        text = _bounded_text(note, "adminNote", MAX_NOTE_LENGTH)
        return self.public_entry(self.store.set_note(entry_id, text, self._clock()))

    def erase(self, entry_id: str) -> None:
        if not self.store.delete(entry_id):
            raise KeyError(entry_id)
        logger.info("Waitlist entry erased", entry_id=entry_id)

    def public_entry(self, entry: dict[str, Any]) -> dict[str, Any]:
        public = {key: value for key, value in entry.items() if key != "inviteTokenHash"}
        public["inviteExpired"] = entry["status"] == "invited" and not self._invite_is_live(entry)
        return public

    def _invite_is_live(self, entry: dict[str, Any]) -> bool:
        expires_at = _parse_iso(entry.get("inviteExpiresAt"))
        if entry.get("status") != "invited" or expires_at is None:
            return False
        return expires_at > self._clock()


def _delivery(result: DeliveryResult) -> dict[str, Any]:
    return {"status": result.status, "error": result.error}


def _unsent(issued: PendingInvite) -> DeliveryResult:
    logger.info("Waitlist invite not emailed: no public web URL", entry_id=issued.entry_id)
    return DeliveryResult("skipped", "No public web URL is configured, so the link was not emailed.")


def _bounded_text(value: Any, field: str, limit: int) -> str | None:
    text = _optional_text(value)
    if text is None:
        return None
    if len(text) > limit:
        raise WaitlistValidationError(f"{field} must be at most {limit} characters.")
    if _CONTROL_CHARACTERS.search(text):
        raise WaitlistValidationError(f"{field} contains characters that are not allowed.")
    return text


def _optional_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _positive_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default
