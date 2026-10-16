"""Password reset over HTTP: the public request/lookup/complete trio and the admin link."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.notifications.mailer import DeliveryResult, EmailMessage

API = "/api/v1"
ADMIN_PASSWORD = "kestrel-vault-7719"
USER_PASSWORD = "harbor-lantern-5521"
NEW_PASSWORD = "quiet-meadow-river-42"
_NOT_LIVE = {"detail": "This reset link is invalid or has expired."}


class FakeMailer:
    def __init__(self) -> None:
        self.sent: list[EmailMessage] = []

    def send(self, message: EmailMessage) -> DeliveryResult:
        self.sent.append(message)
        return DeliveryResult("sent")


@pytest.fixture
def mailer() -> FakeMailer:
    return FakeMailer()


def _app(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_PUBLIC_WEB_URL", "https://get-relay.cc")
    return create_app(tmp_path / "state")


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mailer: FakeMailer) -> TestClient:
    app = _app(monkeypatch, tmp_path)
    app.state.password_reset.mailer = mailer
    return TestClient(app)


def _bootstrap_admin(client: TestClient) -> None:
    response = client.post(
        f"{API}/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "password": ADMIN_PASSWORD},
    )
    assert response.status_code == 200, response.text


def _create_user(client: TestClient, email: str | None = "ada@example.com") -> None:
    body = {"username": "ada", "password": USER_PASSWORD, "role": "user", "userId": "ada"}
    if email:
        body["email"] = email
    response = client.post(f"{API}/admin/accounts", json=body)
    assert response.status_code == 201, response.text


def _token_from(text: str) -> str:
    return text.split("#token=", 1)[1].split()[0]


def _signed_in_user(client: TestClient) -> TestClient:
    other = TestClient(client.app)
    response = other.post(f"{API}/auth/login", json={"username": "ada", "password": USER_PASSWORD})
    assert response.status_code == 200, response.text
    return other


def _login_status(client: TestClient, password: str) -> int:
    return client.post(
        f"{API}/auth/login", json={"username": "ada", "password": password}
    ).status_code


def test_status_reports_whether_reset_can_deliver(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = _app(monkeypatch, tmp_path)
    client = TestClient(app)

    assert client.get(f"{API}/auth/status").json()["passwordResetEnabled"] is False
    assert client.post(f"{API}/auth/password-reset", json={"identifier": "ada"}).status_code == 404

    app.state.password_reset.mailer = FakeMailer()
    assert client.get(f"{API}/auth/status").json()["passwordResetEnabled"] is True


def test_full_reset_flow(client: TestClient, mailer: FakeMailer) -> None:
    _bootstrap_admin(client)
    _create_user(client)
    ada = _signed_in_user(client)

    response = client.post(f"{API}/auth/password-reset", json={"identifier": "ADA@example.com"})
    assert response.status_code == 202
    assert response.json() == {"ok": True}
    assert len(mailer.sent) == 1
    assert "https://get-relay.cc/reset-password#token=" in mailer.sent[0].text
    token = _token_from(mailer.sent[0].text)

    lookup = client.post(f"{API}/auth/password-reset/lookup", json={"token": token})
    assert lookup.status_code == 200
    assert lookup.json()["reset"]["username"] == "ada"

    weak = client.post(
        f"{API}/auth/password-reset/complete", json={"token": token, "password": "short"}
    )
    assert weak.status_code == 400

    done = client.post(
        f"{API}/auth/password-reset/complete", json={"token": token, "password": NEW_PASSWORD}
    )
    assert done.status_code == 200
    assert done.json() == {"ok": True, "username": "ada"}
    assert "relay_session" not in done.cookies
    assert mailer.sent[-1].subject == "Your Relay password was changed"

    assert ada.get(f"{API}/auth/me").status_code == 401
    assert _login_status(client, USER_PASSWORD) == 401
    assert _login_status(client, NEW_PASSWORD) == 200
    again = client.post(
        f"{API}/auth/password-reset/complete", json={"token": token, "password": NEW_PASSWORD}
    )
    assert (again.status_code, again.json()) == (404, _NOT_LIVE)


def test_the_request_answer_never_reveals_an_account(
    client: TestClient, mailer: FakeMailer
) -> None:
    _bootstrap_admin(client)
    _create_user(client)

    answers = [
        client.post(f"{API}/auth/password-reset", json={"identifier": identifier})
        for identifier in ("ada", "nobody", "nobody@example.com")
    ]

    assert {(answer.status_code, answer.text) for answer in answers} == {(202, '{"ok":true}')}
    assert len(mailer.sent) == 1


@pytest.mark.parametrize("body", [{}, {"identifier": ""}, {"identifier": "x" * 300}])
def test_malformed_requests_are_400(client: TestClient, body: dict) -> None:
    assert client.post(f"{API}/auth/password-reset", json=body).status_code == 400


def test_dead_tokens_share_one_answer(client: TestClient) -> None:
    for token in ("", "a" * 43, "not a token"):
        lookup = client.post(f"{API}/auth/password-reset/lookup", json={"token": token})
        assert (lookup.status_code, lookup.json()) == (404, _NOT_LIVE)


def test_requests_are_rate_limited(client: TestClient) -> None:
    statuses = [
        client.post(f"{API}/auth/password-reset", json={"identifier": "ada"}).status_code
        for _ in range(6)
    ]
    assert statuses == [202] * 5 + [429]


def test_admin_link_redeems_without_mail(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    client = TestClient(_app(monkeypatch, tmp_path))
    _bootstrap_admin(client)
    _create_user(client, email=None)

    response = client.post(f"{API}/admin/users/ada/password-reset")

    assert response.status_code == 200, response.text
    issued = response.json()
    assert issued["delivery"] == "skipped"
    assert issued["url"].startswith("https://get-relay.cc/reset-password#token=")
    assert client.post(f"{API}/admin/users/nobody/password-reset").status_code == 404
    token = issued["url"].split("#token=", 1)[1]
    assert client.post(f"{API}/auth/password-reset/lookup", json={"token": token}).status_code == 200
    done = client.post(
        f"{API}/auth/password-reset/complete", json={"token": token, "password": NEW_PASSWORD}
    )
    assert done.status_code == 200
    assert _login_status(client, NEW_PASSWORD) == 200


def test_only_admins_issue_links(client: TestClient) -> None:
    _bootstrap_admin(client)
    _create_user(client)
    ada = _signed_in_user(client)

    assert ada.post(f"{API}/admin/users/admin/password-reset").status_code == 403
    anonymous = TestClient(client.app)
    assert anonymous.post(f"{API}/admin/users/ada/password-reset").status_code == 401


def test_self_serve_needs_a_configured_origin(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.delenv("RELAY_PUBLIC_WEB_URL", raising=False)
    monkeypatch.delenv("RELAY_PUBLIC_BACKEND_URL", raising=False)
    app = create_app(tmp_path / "state")
    app.state.password_reset.mailer = FakeMailer()
    client = TestClient(app)

    # A forged Host must never become the origin of an emailed link, so with
    # nothing configured there is no self-serve reset at all.
    assert client.get(f"{API}/auth/status").json()["passwordResetEnabled"] is False
    response = client.post(
        f"{API}/auth/password-reset",
        json={"identifier": "ada"},
        headers={"Host": "evil.example"},
    )
    assert response.status_code == 404


def test_emailed_links_ignore_the_request_host(client: TestClient, mailer: FakeMailer) -> None:
    _bootstrap_admin(client)
    _create_user(client)

    client.post(
        f"{API}/auth/password-reset", json={"identifier": "ada"}, headers={"Host": "evil.example"}
    )

    assert len(mailer.sent) == 1
    assert "evil.example" not in mailer.sent[0].text
    assert "https://get-relay.cc/reset-password#token=" in mailer.sent[0].text
