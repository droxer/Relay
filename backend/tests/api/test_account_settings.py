from fastapi.testclient import TestClient

from relay.app import create_app


OLD = "kestrel-vault-7719"
NEW = "otter-meadow-8294"


def test_account_settings_are_self_scoped_and_persist(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    client = TestClient(app)
    assert client.patch("/api/v1/auth/profile", json={"displayName": "Ada"}).status_code == 401
    assert client.post("/api/v1/auth/password", json={"currentPassword": OLD, "newPassword": NEW}).status_code == 401
    client.post("/api/v1/auth/bootstrap", json={"token": "admin_token", "username": "admin", "password": OLD})
    other = TestClient(app)
    other.post("/api/v1/auth/login", json={"username": "admin", "password": OLD})
    assert other.get("/api/v1/auth/me").status_code == 200  # Prime the session cache.
    assert client.patch("/api/v1/auth/profile", json={"displayName": "   "}).status_code == 400
    assert client.patch("/api/v1/auth/profile", json={"displayName": "a" * 101}).status_code == 400
    result = client.patch("/api/v1/auth/profile", json={"displayName": " Ada Lovelace ", "role": "user"})
    assert result.status_code == 200
    assert result.json()["user"]["displayName"] == "Ada Lovelace"
    assert result.json()["user"]["role"] == "admin"
    assert other.get("/api/v1/auth/me").json()["user"]["displayName"] == "Ada Lovelace"
    for current, new in [("wrong", NEW), (OLD, "password123"), (OLD, OLD)]:
        assert client.post("/api/v1/auth/password", json={"currentPassword": current, "newPassword": new}).status_code == 400
    result = client.post("/api/v1/auth/password", json={"currentPassword": OLD, "newPassword": NEW})
    assert result.status_code == 200
    assert "password" not in result.text.lower()
    assert client.get("/api/v1/auth/me").status_code == 200
    assert other.get("/api/v1/auth/me").status_code == 401
    fresh = TestClient(app)
    assert fresh.post("/api/v1/auth/login", json={"username": "admin", "password": OLD}).status_code == 401
    assert fresh.post("/api/v1/auth/login", json={"username": "admin", "password": NEW}).status_code == 200


def test_normal_user_cannot_edit_another_account(monkeypatch, tmp_path):
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    app = create_app(str(tmp_path))
    admin = TestClient(app)
    admin.post("/api/v1/auth/bootstrap", json={"token": "admin_token", "username": "admin", "password": OLD})
    created = admin.post("/api/v1/admin/accounts", json={"username": "grace", "password": NEW, "displayName": "Grace Hopper", "role": "user"})
    assert created.status_code == 201
    normal = TestClient(app)
    login = normal.post("/api/v1/auth/login", json={"username": "grace", "password": NEW})
    assert login.json()["user"]["displayName"] == "Grace Hopper"
    admin_id = admin.get("/api/v1/auth/me").json()["user"]["id"]
    changed = normal.patch("/api/v1/auth/profile", json={"displayName": "Grace H.", "id": admin_id, "role": "admin"})
    assert changed.status_code == 200
    assert changed.json()["user"]["role"] == "user"
    prefs = normal.patch("/api/v1/auth/preferences", json={"theme": "dark"})
    assert prefs.json()["user"]["displayName"] == "Grace H."
    assert admin.get("/api/v1/auth/me").json()["user"]["displayName"] == "admin"
    assert normal.post("/api/v1/auth/password", json={"currentPassword": NEW, "newPassword": OLD, "id": admin_id}).status_code == 200
    assert admin.get("/api/v1/auth/me").status_code == 200
