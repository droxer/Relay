"""The waitlist over HTTP: the public join and invite pages and the admin queue."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.notifications.mailer import DeliveryResult, EmailMessage

API = "/api/v1"
ADMIN_PASSWORD = "kestrel-vault-7719"
USER_PASSWORD = "harbor-lantern-5521"


class FakeMailer:
    def __init__(self) -> None:
        self.sent: list[EmailMessage] = []

    def send(self, message: EmailMessage) -> DeliveryResult:
        self.sent.append(message)
        return DeliveryResult("sent")


@pytest.fixture
def mailer() -> FakeMailer:
    return FakeMailer()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mailer: FakeMailer) -> TestClient:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_WAITLIST_ENABLED", "1")
    monkeypatch.setenv("RELAY_PUBLIC_WEB_URL", "https://get-relay.cc")
    monkeypatch.setenv("RELAY_WAITLIST_INVITE_EMAIL", "1")
    app = create_app(tmp_path / "state")
    app.state.waitlist.mailer = mailer
    return TestClient(app)


def _bootstrap_admin(client: TestClient) -> None:
    response = client.post(
        f"{API}/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "password": ADMIN_PASSWORD},
    )
    assert response.status_code == 200, response.text


def _join(client: TestClient, email: str = "ada@example.com", **extra) -> None:
    response = client.post(f"{API}/waitlist", json={"email": email, **extra})
    assert response.status_code == 202, response.text
    assert response.json() == {"ok": True}


def _invite(client: TestClient, email: str = "ada@example.com") -> str:
    entries = client.get(f"{API}/admin/waitlist", params={"status": "waiting"}).json()["entries"]
    entry = next(entry for entry in entries if entry["email"] == email)
    response = client.post(f"{API}/admin/waitlist/{entry['id']}/invite")
    assert response.status_code == 200, response.text
    return response.json()["inviteUrl"].split("#token=", 1)[1]


def test_only_the_public_join_is_gated(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("RELAY_WAITLIST_ENABLED", raising=False)
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    client = TestClient(create_app(tmp_path / "state"))

    assert client.post(f"{API}/waitlist", json={"email": "ada@example.com"}).status_code == 404
    assert client.get(f"{API}/auth/status").json()["waitlistEnabled"] is False
    paths = client.get("/api/openapi.json").json()["paths"]
    assert f"{API}/waitlist" not in paths
    # Inviting does not depend on the public join: an admin can always invite.
    assert f"{API}/admin/waitlist/invitations" in paths
    assert f"{API}/waitlist/invites/accept" in paths
    assert client.get(f"{API}/admin/waitlist").status_code == 401


def test_admin_can_invite_by_email_with_the_waitlist_off(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mailer: FakeMailer
) -> None:
    monkeypatch.delenv("RELAY_WAITLIST_ENABLED", raising=False)
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_PUBLIC_WEB_URL", "https://get-relay.cc")
    monkeypatch.setenv("RELAY_WAITLIST_INVITE_EMAIL", "1")
    app = create_app(tmp_path / "state")
    app.state.waitlist.mailer = mailer
    client = TestClient(app)
    _bootstrap_admin(client)

    response = client.post(
        f"{API}/admin/waitlist/invitations",
        json={"email": "Grace@Example.com", "name": "Grace Hopper", "locale": "en"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["entry"]["status"] == "invited"
    assert body["entry"]["source"] == "admin-invite"
    assert body["delivery"]["status"] == "sent"
    assert "inviteTokenHash" not in body["entry"]
    token = body["inviteUrl"].split("#token=", 1)[1]
    assert body["inviteUrl"] == f"https://get-relay.cc/join#token={token}"
    assert [message.to for message in mailer.sent] == ["grace@example.com"]

    client.cookies.clear()
    accepted = client.post(
        f"{API}/waitlist/invites/accept",
        json={"token": token, "handle": "grace", "password": USER_PASSWORD},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["user"]["email"] == "grace@example.com"


def test_invite_by_email_refuses_bad_input_and_known_accounts(client: TestClient) -> None:
    _bootstrap_admin(client)
    client.post(
        f"{API}/admin/users",
        json={"userId": "plain", "username": "plain", "password": USER_PASSWORD, "email": "plain@example.com"},
    )

    assert client.post(f"{API}/admin/waitlist/invitations", json={"email": "nope"}).status_code == 400
    taken = client.post(f"{API}/admin/waitlist/invitations", json={"email": "PLAIN@example.com"})
    assert taken.status_code == 409
    assert "account" in taken.json()["detail"]


def test_invite_by_email_requires_an_admin(client: TestClient) -> None:
    assert client.post(f"{API}/admin/waitlist/invitations", json={"email": "a@b.co"}).status_code == 401


def test_without_a_public_origin_the_link_is_shown_not_mailed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mailer: FakeMailer
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.delenv("RELAY_PUBLIC_WEB_URL", raising=False)
    monkeypatch.delenv("RELAY_PUBLIC_BACKEND_URL", raising=False)
    monkeypatch.setenv("RELAY_WAITLIST_INVITE_EMAIL", "1")
    app = create_app(tmp_path / "state")
    app.state.waitlist.mailer = mailer
    client = TestClient(app)
    _bootstrap_admin(client)
    assert client.get(f"{API}/admin/settings").json()["capabilities"]["inviteEmail"] is False

    response = client.post(
        f"{API}/admin/waitlist/invitations",
        json={"email": "ada@example.com"},
        headers={"Host": "forged.example"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["delivery"]["status"] == "skipped"
    assert response.json()["inviteUrl"].startswith("http://forged.example/join#token=")
    assert mailer.sent == []


def test_status_and_capabilities_report_the_switch(client: TestClient) -> None:
    assert client.get(f"{API}/auth/status").json() == {
        "requiresBootstrap": True,
        "waitlistEnabled": True,
        "passwordResetEnabled": False,
    }
    _bootstrap_admin(client)
    capabilities = client.get(f"{API}/admin/settings").json()["capabilities"]
    assert capabilities["waitlist"] is True
    assert capabilities["inviteEmail"] is True


def test_join_answers_the_same_for_new_known_and_honeypot(client: TestClient, mailer: FakeMailer) -> None:
    _join(client, "ada@example.com", name="Ada", locale="en")
    _join(client, "ADA@example.com")
    _join(client, "bot@example.com", website="http://spam")

    # The confirmation goes out once, to the one new entry.
    assert [message.to for message in mailer.sent] == ["ada@example.com"]
    _bootstrap_admin(client)
    listed = client.get(f"{API}/admin/waitlist").json()
    assert [entry["email"] for entry in listed["entries"]] == ["ada@example.com"]
    assert listed["counts"]["waiting"] == 1


def test_join_rejects_malformed_input(client: TestClient) -> None:
    assert client.post(f"{API}/waitlist", json={"email": "nope"}).status_code == 400
    assert client.post(f"{API}/waitlist", json={"email": "a@b.co", "name": "x" * 121}).status_code == 400


def test_join_is_rate_limited(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("RELAY_WAITLIST_ENABLED", "1")
    monkeypatch.setenv("RELAY_WAITLIST_RATE_LIMIT_ATTEMPTS", "2")
    client = TestClient(create_app(tmp_path / "state"))
    client.app.state.waitlist.mailer = FakeMailer()

    _join(client, "one@example.com")
    _join(client, "two@example.com")
    blocked = client.post(f"{API}/waitlist", json={"email": "three@example.com"})
    assert blocked.status_code == 429
    assert int(blocked.headers["retry-after"]) > 0


def test_admin_routes_require_an_admin(client: TestClient) -> None:
    assert client.get(f"{API}/admin/waitlist").status_code == 401
    _bootstrap_admin(client)
    client.post(
        f"{API}/admin/users",
        json={"userId": "plain", "username": "plain", "password": USER_PASSWORD},
    )
    client.cookies.clear()
    client.post(f"{API}/auth/login", json={"username": "plain", "password": USER_PASSWORD})
    assert client.get(f"{API}/admin/waitlist").status_code == 403


def test_invite_to_account_end_to_end(client: TestClient, mailer: FakeMailer) -> None:
    _join(client, "ada.l@example.com", name="Ada Lovelace", locale="en")
    _bootstrap_admin(client)
    token = _invite(client, "ada.l@example.com")
    invite_mail = mailer.sent[-1]
    assert f"https://get-relay.cc/join#token={token}" in invite_mail.text
    client.cookies.clear()

    lookup = client.post(f"{API}/waitlist/invites/lookup", json={"token": token})
    assert lookup.status_code == 200
    assert lookup.json()["invite"]["email"] == "ada.l@example.com"
    assert lookup.json()["invite"]["suggestedHandle"] == "ada.l"

    accepted = client.post(
        f"{API}/waitlist/invites/accept", json={"token": token, "handle": "@Ada", "password": USER_PASSWORD}
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["user"]["username"] == "ada"
    me = client.get(f"{API}/auth/me")
    assert me.status_code == 200 and me.json()["user"]["email"] == "ada.l@example.com"

    assert client.post(f"{API}/waitlist/invites/lookup", json={"token": token}).status_code == 404
    reused = client.post(
        f"{API}/waitlist/invites/accept", json={"token": token, "handle": "ada2", "password": USER_PASSWORD}
    )
    assert reused.status_code == 404

    client.cookies.clear()
    client.post(f"{API}/auth/login", json={"username": "admin", "password": ADMIN_PASSWORD})
    joined = client.get(f"{API}/admin/waitlist", params={"status": "joined"}).json()["entries"]
    assert joined[0]["accountId"] == accepted.json()["user"]["id"]


def test_rejected_accepts_leave_the_invite_live(client: TestClient) -> None:
    _join(client)
    _bootstrap_admin(client)
    client.post(
        f"{API}/admin/users",
        json={"userId": "taken", "username": "taken", "password": USER_PASSWORD},
    )
    token = _invite(client)
    client.cookies.clear()
    accept = f"{API}/waitlist/invites/accept"

    weak = client.post(accept, json={"token": token, "handle": "ada", "password": "password"})
    assert weak.status_code == 400
    bad_handle = client.post(accept, json={"token": token, "handle": "a b", "password": USER_PASSWORD})
    assert bad_handle.status_code == 400
    taken = client.post(accept, json={"token": token, "handle": "taken", "password": USER_PASSWORD})
    assert taken.status_code == 409
    assert client.post(f"{API}/waitlist/invites/lookup", json={"token": token}).status_code == 200
    ok = client.post(accept, json={"token": token, "handle": "ada", "password": USER_PASSWORD})
    assert ok.status_code == 200


def test_dead_tokens_get_one_answer(client: TestClient) -> None:
    for token in ("short", "a" * 43, "not.a.token!", ""):
        response = client.post(f"{API}/waitlist/invites/lookup", json={"token": token})
        assert response.status_code == 404
        assert response.json()["detail"] == "This invite link is no longer valid."


def test_tokens_never_appear_in_a_route_path(client: TestClient) -> None:
    paths = client.get("/api/openapi.json").json()["paths"]
    assert not [path for path in paths if "waitlist" in path and "{token}" in path]


def test_admin_queue_actions(client: TestClient, mailer: FakeMailer) -> None:
    for email in ("first@example.com", "second@example.com", "third@example.com"):
        _join(client, email)
    _bootstrap_admin(client)

    batch = client.post(f"{API}/admin/waitlist/invite-batch", json={"count": 2})
    assert batch.status_code == 200
    assert [invite["entry"]["email"] for invite in batch.json()["invites"]] == [
        "first@example.com",
        "second@example.com",
    ]
    # The response carries the links before the emails go out; the test
    # client runs the queued sends before returning.
    assert all(invite["delivery"]["status"] == "queued" for invite in batch.json()["invites"])
    invite_mail = [message.to for message in mailer.sent if message.subject == "Your Relay invite"]
    assert invite_mail == ["first@example.com", "second@example.com"]
    invited = client.get(f"{API}/admin/waitlist", params={"status": "invited"}).json()["entries"]
    assert {entry["lastDeliveryStatus"] for entry in invited} == {"sent"}
    assert client.post(f"{API}/admin/waitlist/invite-batch", json={"count": 0}).status_code == 400

    third = client.get(f"{API}/admin/waitlist", params={"q": "third"}).json()["entries"][0]
    noted = client.patch(f"{API}/admin/waitlist/{third['id']}", json={"adminNote": "VIP"})
    assert noted.json()["entry"]["adminNote"] == "VIP"
    declined = client.post(f"{API}/admin/waitlist/{third['id']}/decline")
    assert declined.json()["entry"]["status"] == "declined"
    assert client.delete(f"{API}/admin/waitlist/{third['id']}").json() == {"ok": True}
    assert client.delete(f"{API}/admin/waitlist/{third['id']}").status_code == 404
    assert client.post(f"{API}/admin/waitlist/missing/invite").status_code == 404
    assert client.get(f"{API}/admin/waitlist", params={"status": "bogus"}).status_code == 400


def test_a_deleted_users_address_can_be_invited_again(client: TestClient, mailer: FakeMailer) -> None:
    _bootstrap_admin(client)
    first = client.post(f"{API}/admin/waitlist/invitations", json={"email": "gone@example.com"})
    token = first.json()["inviteUrl"].split("#token=", 1)[1]
    client.cookies.clear()
    accepted = client.post(
        f"{API}/waitlist/invites/accept",
        json={"token": token, "handle": "gone", "password": USER_PASSWORD},
    )
    assert accepted.status_code == 200, accepted.text
    user_id = accepted.json()["user"]["userId"]
    client.cookies.clear()
    client.post(f"{API}/auth/login", json={"username": "admin", "password": ADMIN_PASSWORD})
    # Still a live account: refused.
    assert client.post(f"{API}/admin/waitlist/invitations", json={"email": "gone@example.com"}).status_code == 409

    assert client.delete(f"{API}/admin/users/{user_id}").status_code in (200, 204)

    again = client.post(f"{API}/admin/waitlist/invitations", json={"email": "gone@example.com"})
    assert again.status_code == 200, again.text
    assert again.json()["entry"]["status"] == "invited"
    assert again.json()["entry"]["accountId"] is None


def test_invites_are_links_only_unless_invite_email_is_on(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, mailer: FakeMailer
) -> None:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_PUBLIC_WEB_URL", "https://get-relay.cc")
    monkeypatch.delenv("RELAY_WAITLIST_INVITE_EMAIL", raising=False)
    app = create_app(tmp_path / "state")
    app.state.waitlist.mailer = mailer
    client = TestClient(app)
    _bootstrap_admin(client)
    assert client.get(f"{API}/admin/settings").json()["capabilities"]["inviteEmail"] is False

    response = client.post(f"{API}/admin/waitlist/invitations", json={"email": "grace@example.com"})

    assert response.status_code == 200, response.text
    assert response.json()["delivery"] is None
    assert response.json()["inviteUrl"].startswith("https://get-relay.cc/join#token=")
    assert mailer.sent == []
