"""Email at the HTTP edge: required on every new Account, a sign-in identifier,
and a duplicate answered as an email conflict rather than a handle one."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app

API = "/api/v1"
ADMIN_PASSWORD = "kestrel-vault-7719"
USER_PASSWORD = "harbor-lantern-5521"
EMAIL_TAKEN = "An account with this email already exists."


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_PUBLIC_WEB_URL", "https://get-relay.cc")
    return TestClient(create_app(tmp_path / "state"))


def _bootstrap(client: TestClient, **body: str) -> object:
    return client.post(f"{API}/auth/bootstrap", json={
        "token": "admin_token", "username": "admin", "password": ADMIN_PASSWORD, **body,
    })


def _signed_in_admin(client: TestClient) -> None:
    response = _bootstrap(client, email="admin@example.com")
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("email", [None, "", "admin", "admin@localhost"])
def test_bootstrap_refuses_a_missing_or_invalid_email(client: TestClient, email) -> None:
    body = {} if email is None else {"email": email}
    response = _bootstrap(client, **body)
    assert response.status_code == 400
    assert "email" in response.json()["detail"].lower()
    assert client.get(f"{API}/auth/status").json()["requiresBootstrap"] is True


def test_bootstrap_stores_the_normalized_email(client: TestClient) -> None:
    response = _bootstrap(client, email=" Admin@Example.COM ")
    assert response.status_code == 200, response.text
    assert response.json()["user"]["email"] == "admin@example.com"


def test_login_accepts_email_or_username_in_the_username_field(client: TestClient) -> None:
    _signed_in_admin(client)
    client.cookies.clear()
    by_email = client.post(f"{API}/auth/login", json={
        "username": "ADMIN@example.com", "password": ADMIN_PASSWORD,
    })
    assert by_email.status_code == 200, by_email.text
    client.cookies.clear()
    by_name = client.post(f"{API}/auth/login", json={"username": "admin", "password": ADMIN_PASSWORD})
    assert by_name.status_code == 200
    client.cookies.clear()
    wrong = client.post(f"{API}/auth/login", json={
        "username": "admin@example.com", "password": "wrong-password-11",
    })
    assert wrong.status_code == 401
    unknown = client.post(f"{API}/auth/login", json={
        "username": "ghost@example.com", "password": ADMIN_PASSWORD,
    })
    assert unknown.status_code == 401
    assert unknown.json()["detail"] == wrong.json()["detail"]


def test_admin_account_creation_requires_a_unique_email(client: TestClient) -> None:
    _signed_in_admin(client)
    missing = client.post(f"{API}/admin/accounts", json={"username": "bea", "password": USER_PASSWORD})
    assert missing.status_code == 400
    duplicate = client.post(f"{API}/admin/accounts", json={
        "username": "bea", "password": USER_PASSWORD, "email": "ADMIN@example.com",
    })
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == EMAIL_TAKEN


def test_admin_user_creation_reports_a_taken_email_as_an_email_conflict(client: TestClient) -> None:
    _signed_in_admin(client)
    missing = client.post(f"{API}/admin/users", json={
        "userId": "cal", "username": "cal", "password": USER_PASSWORD,
    })
    assert missing.status_code == 400
    assert "email" in missing.json()["detail"].lower()
    duplicate = client.post(f"{API}/admin/users", json={
        "userId": "cal", "username": "cal", "password": USER_PASSWORD, "email": "admin@EXAMPLE.com",
    })
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == EMAIL_TAKEN
    created = client.post(f"{API}/admin/users", json={
        "userId": "cal", "username": "cal", "password": USER_PASSWORD, "email": "Cal@Example.com",
    })
    assert created.status_code == 201, created.text
    assert created.json()["account"]["email"] == "cal@example.com"
    assert created.json()["user"]["email"] == "cal@example.com"


def test_admin_email_edit_rejects_a_taken_address(client: TestClient) -> None:
    _signed_in_admin(client)
    created = client.post(f"{API}/admin/users", json={
        "userId": "dee", "username": "dee", "password": USER_PASSWORD, "email": "dee@example.com",
    }).json()
    taken = client.patch(f"{API}/admin/users/{created['user']['id']}", json={"email": "admin@example.com"})
    assert taken.status_code == 409
    assert taken.json()["detail"] == EMAIL_TAKEN
    invalid = client.patch(f"{API}/admin/users/{created['user']['id']}", json={"email": "nope"})
    assert invalid.status_code == 400
    moved = client.patch(f"{API}/admin/users/{created['user']['id']}", json={"email": "Dee2@example.com"})
    assert moved.status_code == 200, moved.text
    client.cookies.clear()
    login = client.post(f"{API}/auth/login", json={"username": "dee2@example.com", "password": USER_PASSWORD})
    assert login.status_code == 200, login.text


def test_an_invite_to_an_address_taken_since_reports_the_email(client: TestClient) -> None:
    _signed_in_admin(client)
    invited = client.post(f"{API}/admin/waitlist/invitations", json={"email": "eve@example.com"})
    assert invited.status_code in (200, 201), invited.text
    token = invited.json()["inviteUrl"].split("#token=", 1)[1]
    taken = client.post(f"{API}/admin/accounts", json={
        "username": "eve-admin-made", "password": USER_PASSWORD, "email": "eve@example.com",
    })
    assert taken.status_code == 201, taken.text
    client.cookies.clear()

    accepted = client.post(f"{API}/waitlist/invites/accept", json={
        "token": token, "handle": "eve", "password": USER_PASSWORD,
    })
    assert accepted.status_code == 409
    assert accepted.json()["detail"] == EMAIL_TAKEN
    # The claim is released, so the invite still answers.
    assert client.post(f"{API}/waitlist/invites/lookup", json={"token": token}).status_code == 200
