"""Transactional email, behind one seam.

``CloudflareMailer`` sends through Cloudflare Email Service's REST API; the
backend, not a Worker, sends, because the backend owns the state change the
email announces. ``NullMailer`` is what an install without mail settings gets:
it sends nothing, and callers fall back to showing the link to an admin.

A send never raises: it returns a ``DeliveryResult`` so a mail outage cannot
roll back or block the transition that triggered it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal, Protocol

import httpx
from loguru import logger

DeliveryStatus = Literal["sent", "bounced", "failed", "skipped"]

CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"
SEND_TIMEOUT_SECONDS = 5.0
MAIL_ENV = (
    "RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID",
    "RELAY_MAIL_CLOUDFLARE_API_TOKEN",
    "RELAY_MAIL_FROM",
)


@dataclass(frozen=True)
class EmailMessage:
    to: str
    subject: str
    text: str
    html: str


@dataclass(frozen=True)
class DeliveryResult:
    status: DeliveryStatus
    error: str | None = None
    # Throttling and upstream outages are worth retrying; a bad token is not.
    retryable: bool = False


class Mailer(Protocol):
    def send(self, message: EmailMessage) -> DeliveryResult: ...


class NullMailer:
    def send(self, message: EmailMessage) -> DeliveryResult:
        return DeliveryResult("skipped", "Email delivery is not configured.")


class CloudflareMailer:
    def __init__(
        self,
        *,
        account_id: str,
        api_token: str,
        sender: str,
        client: httpx.Client | None = None,
    ):
        self._url = f"{CLOUDFLARE_API_BASE}/accounts/{account_id}/email/sending/send"
        self._token = api_token
        self._sender = sender
        # Built on first send, so startup never depends on proxy settings.
        self._client = client

    def send(self, message: EmailMessage) -> DeliveryResult:
        payload = {
            "to": message.to,
            "from": self._sender,
            "subject": message.subject,
            "text": message.text,
            "html": message.html,
        }
        if self._client is None:
            self._client = httpx.Client(timeout=SEND_TIMEOUT_SECONDS)
        try:
            response = self._client.post(
                self._url,
                json=payload,
                headers={"Authorization": f"Bearer {self._token}"},
            )
            body = response.json()
        except (httpx.HTTPError, ValueError) as error:
            logger.warning("Email send failed", error=type(error).__name__)
            return DeliveryResult("failed", "Email service unreachable.", retryable=True)
        return _result_from_response(response.status_code, body, message.to)


def _result_from_response(status_code: int, body: object, recipient: str) -> DeliveryResult:
    if not isinstance(body, dict):
        return DeliveryResult("failed", f"Unexpected email service response ({status_code}).")
    if status_code < 300 and body.get("success"):
        result = body.get("result") or {}
        if recipient in (result.get("permanent_bounces") or []):
            return DeliveryResult("bounced", "The address permanently bounced.")
        return DeliveryResult("sent")
    errors = body.get("errors") or []
    first = errors[0] if errors and isinstance(errors[0], dict) else {}
    code = first.get("code")
    detail = first.get("message") or f"HTTP {status_code}"
    if status_code in (401, 403):
        # A bad token, a missing entitlement, or sending disabled for the zone:
        # every send will fail until an operator fixes the configuration.
        logger.error("Email service rejected the configured credentials", code=code, detail=detail)
        return DeliveryResult("failed", f"Email service configuration error: {detail}")
    retryable = status_code == 429 or status_code >= 500
    logger.warning("Email send rejected", status=status_code, code=code, detail=detail)
    return DeliveryResult("failed", f"Email service error: {detail}", retryable=retryable)


def mailer_from_env() -> Mailer:
    """The configured mailer; refuse a half-configured one at startup.

    Falling back to ``NullMailer`` when one setting is missing would silently
    drop every invite, so a partial configuration is an error instead."""
    values = {name: os.environ.get(name, "").strip() for name in MAIL_ENV}
    present = [name for name, value in values.items() if value]
    if not present:
        return NullMailer()
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise RuntimeError(
            "Email delivery is partly configured; also set " + ", ".join(missing) + "."
        )
    logger.info("Email delivery enabled through Cloudflare Email Service")
    return CloudflareMailer(
        account_id=values["RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID"],
        api_token=values["RELAY_MAIL_CLOUDFLARE_API_TOKEN"],
        sender=values["RELAY_MAIL_FROM"],
    )
