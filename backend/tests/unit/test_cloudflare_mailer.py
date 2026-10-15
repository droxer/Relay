"""Cloudflare Email Service adapter: request shape and response mapping.

No network: every response comes from an ``httpx.MockTransport``.
"""

from __future__ import annotations

import json

import httpx
import pytest
from relay.notifications.mailer import (
    CloudflareMailer,
    EmailMessage,
    NullMailer,
    mailer_from_env,
)

TOKEN = "cf-send-only-token"
MESSAGE = EmailMessage(to="ada@example.com", subject="Your Relay invite", text="hi", html="<p>hi</p>")


def _mailer(handler) -> tuple[CloudflareMailer, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    client = httpx.Client(transport=httpx.MockTransport(record))
    mailer = CloudflareMailer(
        account_id="acct123", api_token=TOKEN, sender="Relay <invites@mail.get-relay.cc>", client=client
    )
    return mailer, seen


def _ok(result: dict) -> httpx.Response:
    return httpx.Response(200, json={"success": True, "errors": [], "messages": [], "result": result})


def _error(status: int, code: int, message: str) -> httpx.Response:
    return httpx.Response(
        status,
        json={"success": False, "errors": [{"code": code, "message": message}], "messages": [], "result": None},
    )


def test_sends_one_recipient_with_bearer_token() -> None:
    mailer, seen = _mailer(lambda request: _ok({"delivered": ["ada@example.com"]}))

    result = mailer.send(MESSAGE)

    assert result.status == "sent"
    request = seen[0]
    assert str(request.url) == "https://api.cloudflare.com/client/v4/accounts/acct123/email/sending/send"
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert json.loads(request.content) == {
        "to": "ada@example.com",
        "from": "Relay <invites@mail.get-relay.cc>",
        "subject": "Your Relay invite",
        "text": "hi",
        "html": "<p>hi</p>",
    }


def test_queued_counts_as_sent() -> None:
    mailer, _ = _mailer(lambda request: _ok({"delivered": [], "queued": ["ada@example.com"]}))
    assert mailer.send(MESSAGE).status == "sent"


def test_permanent_bounce_is_reported() -> None:
    mailer, _ = _mailer(lambda request: _ok({"permanent_bounces": ["ada@example.com"]}))
    result = mailer.send(MESSAGE)
    assert result.status == "bounced"
    assert result.retryable is False


@pytest.mark.parametrize(
    ("status", "code", "message", "retryable"),
    [
        (429, 10004, "email.sending.error.throttled", True),
        (500, 10002, "email.sending.error.internal_server", True),
        (400, 10001, "email.sending.error.invalid_request_schema", False),
        (403, 10105, "email.sending.error.authentication.not_entitled", False),
        (403, 10203, "email.sending.error.email.sending_disabled", False),
        (401, 10101, "email.sending.error.authentication.unauthorized", False),
    ],
)
def test_error_envelopes_map_to_failed(status: int, code: int, message: str, retryable: bool) -> None:
    mailer, _ = _mailer(lambda request: _error(status, code, message))

    result = mailer.send(MESSAGE)

    assert result.status == "failed"
    assert result.retryable is retryable
    assert message in (result.error or "")
    assert TOKEN not in (result.error or "")


def test_network_failure_is_retryable_and_never_raises() -> None:
    def explode(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    mailer, _ = _mailer(explode)
    result = mailer.send(MESSAGE)
    assert result.status == "failed" and result.retryable is True


def test_non_json_response_fails_cleanly() -> None:
    mailer, _ = _mailer(lambda request: httpx.Response(502, text="<html>bad gateway</html>"))
    assert mailer.send(MESSAGE).status == "failed"


def test_mailer_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID", "RELAY_MAIL_CLOUDFLARE_API_TOKEN", "RELAY_MAIL_FROM"):
        monkeypatch.delenv(name, raising=False)
    assert isinstance(mailer_from_env(), NullMailer)
    assert NullMailer().send(MESSAGE).status == "skipped"

    monkeypatch.setenv("RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID", "acct123")
    with pytest.raises(RuntimeError, match="RELAY_MAIL_CLOUDFLARE_API_TOKEN, RELAY_MAIL_FROM"):
        mailer_from_env()

    monkeypatch.setenv("RELAY_MAIL_CLOUDFLARE_API_TOKEN", TOKEN)
    monkeypatch.setenv("RELAY_MAIL_FROM", "invites@mail.get-relay.cc")
    assert isinstance(mailer_from_env(), CloudflareMailer)
