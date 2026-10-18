"""How many personal computers a user may enroll.

Covers the global default, the per-user override, and the two paths that
can bring a personal computer into existence.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient

from relay.app import create_app
from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.security.auth import DatabaseAccountAuthStore


def _bootstrap_admin(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "password": "kestrel-vault-7719"},
    )
    assert response.status_code == 200


def _login(client: TestClient, username: str, password: str = "userpass") -> None:
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200


def _login_admin(client: TestClient) -> None:
    _login(client, "admin", "kestrel-vault-7719")


def _create_user(client: TestClient, user_id: str, **extra: object) -> dict:
    response = client.post(
        "/api/v1/admin/users",
        json={
            "userId": user_id,
            "username": user_id,
            "password": "userpass",
            **extra,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["user"]


def _enroll(client: TestClient, workspace_path: str) -> object:
    return client.post(
        "/api/v1/daemon-node-enrollments/local",
        json={"workspacePath": workspace_path, "sandboxMode": "none"},
    )


def _set_global_limit(client: TestClient, limit: int) -> None:
    response = client.put(
        "/api/v1/admin/settings", json={"maxLocalComputersPerUser": limit}
    )
    assert response.status_code == 200, response.text


@contextmanager
def _client(monkeypatch: pytest.MonkeyPatch, *, database_auth: bool) -> Iterator[TestClient]:
    """A signed-out client, admin-bootstrapped.

    The per-user override lives on the users table, so tests that need
    one run against the database auth store; the rest exercise the file store
    that the backend defaults to.
    """
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    with TemporaryDirectory() as root:
        if database_auth:
            monkeypatch.setenv("RELAY_AUTH_STORE", "database")
            database_url = f"sqlite:///{root}/auth.db"
            monkeypatch.setenv("RELAY_DATABASE_URL", database_url)
            DatabaseAccountAuthStore(database_url, create_schema=True)
        client = TestClient(create_app(root))
        _bootstrap_admin(client)
        yield client


def test_settings_default_and_update(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        response = client.get("/api/v1/admin/settings")
        assert response.status_code == 200
        assert response.json()["settings"]["maxLocalComputersPerUser"] == 3

        _set_global_limit(client, 7)
        assert (
            client.get("/api/v1/admin/settings").json()["settings"][
                "maxLocalComputersPerUser"
            ]
            == 7
        )


def test_settings_report_whether_user_edits_are_storable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        assert (
            client.get("/api/v1/admin/settings").json()["capabilities"]["userEdits"]
            is False
        )
    with _client(monkeypatch, database_auth=True) as client:
        assert (
            client.get("/api/v1/admin/settings").json()["capabilities"]["userEdits"]
            is True
        )


def test_settings_report_the_admin_token_without_revealing_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        body = client.get("/api/v1/admin/settings").json()
        assert body["adminTokenConfigured"] is True
        assert "adminToken" not in body
        assert "admin_token" not in json.dumps(body)

        _create_user(client, "alice")
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert client.get("/api/v1/admin/settings").status_code == 401

        _login(client, "alice")
        assert client.get("/api/v1/admin/settings").status_code == 403
        assert client.post("/api/v1/admin/admin-token/reissue").status_code == 403


def test_admin_token_survives_a_restart_without_a_data_volume(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        token = client.post("/api/v1/admin/admin-token/reissue").json()["adminToken"]

    # A fresh data dir is a redeployed container with no volume; the database
    # is the same one, so the token issued before still authenticates.
    monkeypatch.delenv("RELAY_ADMIN_TOKEN")
    with TemporaryDirectory() as fresh_root:
        restarted = TestClient(create_app(fresh_root))
        response = restarted.get(
            "/api/v1/admin/settings", headers={"authorization": f"Bearer {token}"}
        )
        assert response.status_code == 200
        assert response.json()["adminTokenConfigured"] is True
        assert not (Path(fresh_root) / "auth" / "admin-token").exists()


def test_admin_token_reissue_returns_it_once_and_invalidates_the_old_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        response = client.post("/api/v1/admin/admin-token/reissue")
        assert response.status_code == 200
        new_token = response.json()["adminToken"]
        assert new_token and new_token != "admin_token"
        assert "adminToken" not in client.get("/api/v1/admin/settings").json()

        anonymous = TestClient(client.app)
        assert (
            anonymous.get(
                "/api/v1/admin/settings",
                headers={"authorization": "Bearer admin_token"},
            ).status_code
            == 401
        )
        assert (
            anonymous.get(
                "/api/v1/admin/settings",
                headers={"authorization": f"Bearer {new_token}"},
            ).status_code
            == 200
        )


def test_settings_reject_out_of_range_and_non_numeric(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        for value in (-1, 51, "many", None):
            response = client.put(
                "/api/v1/admin/settings", json={"maxLocalComputersPerUser": value}
            )
            assert response.status_code == 400, value


def test_settings_require_admin_session(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        _create_user(client, "alice")
        assert client.post("/api/v1/auth/logout").status_code == 200
        assert client.get("/api/v1/admin/settings").status_code == 401

        _login(client, "alice")
        assert client.get("/api/v1/admin/settings").status_code == 403
        assert (
            client.put(
                "/api/v1/admin/settings", json={"maxLocalComputersPerUser": 9}
            ).status_code
            == 403
        )


def test_enrollment_stops_at_the_global_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        _set_global_limit(client, 2)
        _create_user(client, "alice")
        assert client.post("/api/v1/auth/logout").status_code == 200
        _login(client, "alice")

        assert _enroll(client, "/Users/alice/one").status_code == 201
        assert _enroll(client, "/Users/alice/two").status_code == 201

        response = _enroll(client, "/Users/alice/three")
        assert response.status_code == 409
        assert "2 of 2" in response.json()["detail"]


def test_re_enrolling_an_adopted_computer_is_allowed_at_the_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        _set_global_limit(client, 1)
        _create_user(client, "alice")
        assert client.post("/api/v1/auth/logout").status_code == 200
        _login(client, "alice")

        assert _enroll(client, "/Users/alice/only").status_code == 201
        response = _enroll(client, "/Users/alice/only")
        assert response.status_code == 201
        assert response.json()["reused"] is True


def test_zero_limit_blocks_every_enrollment(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        _set_global_limit(client, 0)
        _create_user(client, "alice")
        assert client.post("/api/v1/auth/logout").status_code == 200
        _login(client, "alice")

        assert _enroll(client, "/Users/alice/one").status_code == 409


def test_lowering_the_limit_grandfathers_existing_computers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        _set_global_limit(client, 3)
        _create_user(client, "alice")
        assert client.post("/api/v1/auth/logout").status_code == 200
        _login(client, "alice")
        assert _enroll(client, "/Users/alice/one").status_code == 201
        assert _enroll(client, "/Users/alice/two").status_code == 201

        assert client.post("/api/v1/auth/logout").status_code == 200
        _login_admin(client)
        _set_global_limit(client, 1)

        nodes = client.get("/api/v1/admin/daemon-nodes").json()["nodes"]
        assert len([node for node in nodes if node.get("userId") == "alice"]) == 2

        assert client.post("/api/v1/auth/logout").status_code == 200
        _login(client, "alice")
        assert _enroll(client, "/Users/alice/three").status_code == 409
        # The computers they already had keep answering.
        assert _enroll(client, "/Users/alice/one").json()["reused"] is True


def test_admin_node_creation_respects_the_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        _set_global_limit(client, 1)
        _create_user(client, "alice")

        first = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "userId": "alice",
                "sandboxMode": "none",
                "nodeLocation": "user-device",
                "workspacePath": "/Users/alice/one",
            },
        )
        assert first.status_code == 201

        second = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "userId": "alice",
                "sandboxMode": "none",
                "nodeLocation": "user-device",
                "workspacePath": "/Users/alice/two",
            },
        )
        assert second.status_code == 409


def test_managed_node_creation_ignores_the_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        _set_global_limit(client, 0)
        _create_user(client, "alice")

        response = client.post(
            "/api/v1/admin/daemon-nodes",
            json={"userId": "alice", "sandboxMode": "boxlite"},
        )
        assert response.status_code == 201


def test_user_override_beats_the_global(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client(monkeypatch, database_auth=True) as client:
        _set_global_limit(client, 1)
        user = _create_user(client, "alice", maxLocalComputers=2)
        assert user["maxLocalComputers"] == 2
        assert user["effectiveMaxLocalComputers"] == 2

        assert client.post("/api/v1/auth/logout").status_code == 200
        _login(client, "alice")
        assert _enroll(client, "/Users/alice/one").status_code == 201
        assert _enroll(client, "/Users/alice/two").status_code == 201
        assert _enroll(client, "/Users/alice/three").status_code == 409


def test_users_without_an_override_follow_the_global(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=True) as client:
        # The database auth store mints its own user id, so read it back
        # rather than assuming the requested one.
        alice_id = _create_user(client, "alice")["id"]
        _set_global_limit(client, 8)

        users = {
            user["id"]: user
            for user in client.get("/api/v1/admin/users").json()["users"]
        }
        alice = users[alice_id]
        assert alice["maxLocalComputers"] is None
        assert alice["effectiveMaxLocalComputers"] == 8
        assert alice["localComputerCount"] == 0


def test_patch_sets_and_clears_the_override(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client(monkeypatch, database_auth=True) as client:
        _set_global_limit(client, 4)
        alice_id = _create_user(client, "alice")["id"]

        response = client.patch(
            f"/api/v1/admin/users/{alice_id}",
            json={"displayName": "Alice A", "email": "alice@example.com",
                  "maxLocalComputers": 1},
        )
        assert response.status_code == 200, response.text
        user = response.json()["user"]
        assert user["displayName"] == "Alice A"
        assert user["email"] == "alice@example.com"
        assert user["maxLocalComputers"] == 1
        assert user["effectiveMaxLocalComputers"] == 1

        cleared = client.patch(
            f"/api/v1/admin/users/{alice_id}", json={"maxLocalComputers": None}
        )
        assert cleared.status_code == 200
        assert cleared.json()["user"]["maxLocalComputers"] is None
        # Back to inheriting, so a later global change moves them again.
        assert cleared.json()["user"]["effectiveMaxLocalComputers"] == 4
        # An unrelated edit leaves the cleared override alone.
        assert (
            client.patch(
                f"/api/v1/admin/users/{alice_id}", json={"displayName": "Alice B"}
            ).json()["user"]["maxLocalComputers"]
            is None
        )


def test_patch_rejects_unknown_user_and_bad_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=True) as client:
        alice_id = _create_user(client, "alice")["id"]
        assert (
            client.patch(
                "/api/v1/admin/users/nobody", json={"displayName": "Ghost"}
            ).status_code
            == 404
        )
        assert (
            client.patch(
                f"/api/v1/admin/users/{alice_id}", json={"maxLocalComputers": 99}
            ).status_code
            == 400
        )
        assert (
            client.patch(
                f"/api/v1/admin/users/{alice_id}", json={"displayName": "  "}
            ).status_code
            == 400
        )


def test_override_at_creation_needs_the_database_auth_store(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        response = client.post(
            "/api/v1/admin/users",
            json={
                "userId": "alice",
                "username": "alice",
                "password": "userpass",
                "maxLocalComputers": 2,
            },
        )
        assert response.status_code == 400
        assert "database auth store" in response.json()["detail"]


def test_disconnecting_a_computer_frees_a_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        _set_global_limit(client, 1)
        _create_user(client, "alice")
        assert client.post("/api/v1/auth/logout").status_code == 200
        _login(client, "alice")

        enrolled = _enroll(client, "/Users/alice/one")
        assert enrolled.status_code == 201
        node_id = enrolled.json()["node"]["id"]
        assert _enroll(client, "/Users/alice/two").status_code == 409

        assert client.delete(f"/api/v1/daemon-nodes/{node_id}").status_code == 204
        assert _enroll(client, "/Users/alice/two").status_code == 201


def test_settings_default_and_update_task_rounds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=False) as client:
        assert client.get("/api/v1/admin/settings").json()["settings"][
            "maxTaskRounds"
        ] == 5

        assert (
            client.put(
                "/api/v1/admin/settings", json={"maxTaskRounds": 9}
            ).status_code
            == 200
        )
        assert client.get("/api/v1/admin/settings").json()["settings"][
            "maxTaskRounds"
        ] == 9

        assert (
            client.put("/api/v1/admin/settings", json={"maxTaskRounds": 0}).status_code
            == 400
        )


def test_saving_one_setting_leaves_the_other_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Each card sends only its own field, so one save cannot revert the other."""
    with _client(monkeypatch, database_auth=False) as client:
        _set_global_limit(client, 7)
        assert (
            client.put(
                "/api/v1/admin/settings", json={"maxTaskRounds": 2}
            ).status_code
            == 200
        )

        settings = client.get("/api/v1/admin/settings").json()["settings"]
        assert settings["maxLocalComputersPerUser"] == 7
        assert settings["maxTaskRounds"] == 2

        assert (
            client.put("/api/v1/admin/settings", json={}).status_code == 400
        )


def test_auth_me_carries_the_caller_limit_and_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Self-service surfaces gate their connect action on /auth/me, so the
    session payload must carry the resolved limit and live usage — an
    admin-only endpoint cannot serve the user's own page."""
    with _client(monkeypatch, database_auth=False) as client:
        _set_global_limit(client, 2)
        _create_user(client, "alice")
        assert client.post("/api/v1/auth/logout").status_code == 200
        _login(client, "alice")

        me = client.get("/api/v1/auth/me").json()["user"]
        assert me["effectiveMaxLocalComputers"] == 2
        assert me["localComputerCount"] == 0

        assert _enroll(client, "/Users/alice/one").status_code == 201
        me = client.get("/api/v1/auth/me").json()["user"]
        assert me["localComputerCount"] == 1


def test_auth_me_reflects_the_user_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=True) as client:
        _set_global_limit(client, 5)
        _create_user(client, "alice", maxLocalComputers=1)
        assert client.post("/api/v1/auth/logout").status_code == 200
        _login(client, "alice")

        me = client.get("/api/v1/auth/me").json()["user"]
        assert me["maxLocalComputers"] == 1
        assert me["effectiveMaxLocalComputers"] == 1


def test_auth_me_omits_limits_for_users_without_an_user(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A user with no user link cannot enroll a computer at all, so their
    # payload stays bare rather than implying a limit of zero.
    with _client(monkeypatch, database_auth=False) as client:
        me = client.get("/api/v1/auth/me").json()["user"]
        assert "effectiveMaxLocalComputers" not in me
        assert "localComputerCount" not in me


def test_preferences_response_keeps_the_limit_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The client replaces its session user with the preferences response, so
    # an undecorated payload here silently ungates the connect CTA until the
    # next reload.
    with _client(monkeypatch, database_auth=False) as client:
        _set_global_limit(client, 2)
        _create_user(client, "alice")
        assert client.post("/api/v1/auth/logout").status_code == 200
        _login(client, "alice")

        response = client.patch("/api/v1/auth/preferences", json={"theme": "dark"})
        assert response.status_code == 200
        account = response.json()["user"]
        assert account["effectiveMaxLocalComputers"] == 2
        assert account["localComputerCount"] == 0


def test_login_response_carries_the_limit_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # LoginScreen seeds the session user straight from the login response —
    # there is no /auth/me round trip before the My Computer page can render.
    with _client(monkeypatch, database_auth=False) as client:
        _set_global_limit(client, 4)
        _create_user(client, "alice")
        assert client.post("/api/v1/auth/logout").status_code == 200

        response = client.post(
            "/api/v1/auth/login", json={"username": "alice", "password": "userpass"}
        )
        assert response.status_code == 200
        assert response.json()["user"]["effectiveMaxLocalComputers"] == 4


def test_user_id_collision_is_rejected_not_merged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A second "alice" is a collision, not a second user.

    The stores' ensure_user reuses a matching row and patches the profile
    onto it, so without a check the create route silently rewrote the live
    user's display name, email, and computer limit and attached a second
    login to them.
    """
    with _client(monkeypatch, database_auth=True) as client:
        _login_admin(client)
        first = _create_user(
            client, "alice", displayName="Alice Chen", maxLocalComputers=2
        )

        clash = client.post(
            "/api/v1/admin/users",
            json={
                "userId": "alice",
                "username": "alice2",
                "password": "userpass",
                "displayName": "Someone Else",
                "maxLocalComputers": 9,
            },
        )
        assert clash.status_code == 409, clash.text

        users = {
            user["id"]: user
            for user in client.get("/api/v1/admin/users").json()["users"]
        }
        untouched = users[first["id"]]
        assert untouched["displayName"] == "Alice Chen"
        assert untouched["maxLocalComputers"] == 2


def test_user_id_is_normalized_and_validated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=True) as client:
        _login_admin(client)

        for bad in ("a b", "Alice/Bob", "a", "@@", "-"):
            response = client.post(
                "/api/v1/admin/users",
                json={
                    "userId": bad,
                    "username": f"user-{abs(hash(bad))}",
                    "password": "userpass",
                },
            )
            assert response.status_code == 400, f"{bad}: {response.text}"

        # A decorated, upper-cased handle is accepted and canonicalized, so the
        # form's "@alice" preview matches what is actually created.
        created = client.post(
            "/api/v1/admin/users",
            json={
                "userId": "  @Alice  ",
                "username": "alice",
                "password": "userpass",
            },
        )
        assert created.status_code == 201, created.text
        # ...and the canonical form now collides with the decorated one.
        again = client.post(
            "/api/v1/admin/users",
            json={"userId": "alice", "username": "alice3", "password": "userpass"},
        )
        assert again.status_code == 409, again.text


def test_user_survives_a_computer_claimed_mid_create(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The user is committed before assignment, so a lost race is a warning.

    Raising here left a created user behind an error message, and the retry
    then failed on "username already exists" with no way forward.
    """
    with _client(monkeypatch, database_auth=True) as client:
        _login_admin(client)
        # An unassigned computer for the new user to be given.
        created_node = client.post(
            "/api/v1/admin/daemon-nodes",
            json={
                "sandboxMode": "none",
                "nodeLocation": "user-device",
                "workspacePath": "/Users/bob/one",
            },
        )
        assert created_node.status_code == 201, created_node.text
        node_id = created_node.json()["node"]["id"]

        # Someone else claims it between the route's pre-check and the assign.
        def _claimed(*_args: object, **_kwargs: object) -> dict:
            raise ValueError("Daemon node is already assigned.")

        monkeypatch.setattr(DaemonNodeRegistry, "assign_user", _claimed)

        response = client.post(
            "/api/v1/admin/users",
            json={
                "userId": "bob",
                "username": "bob",
                "password": "userpass",
                "nodeId": node_id,
            },
        )
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["assignmentError"] == "Daemon node is already assigned."
        assert "node" not in body

        # The user is real, and is not a half-created ghost the admin has to
        # fight past on a retry.
        monkeypatch.undo()
        handles = {
            user["displayName"]
            for user in client.get("/api/v1/admin/users").json()["users"]
        }
        assert "bob" in handles


def test_unknown_computer_is_still_refused_before_the_user_exists(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pre-check stays: a node id that never existed is a bad request, and
    nothing is created for it."""
    with _client(monkeypatch, database_auth=True) as client:
        _login_admin(client)
        response = client.post(
            "/api/v1/admin/users",
            json={
                "userId": "carol",
                "username": "carol",
                "password": "userpass",
                "nodeId": "computer-that-does-not-exist",
            },
        )
        assert response.status_code == 404, response.text
        names = {
            user["displayName"]
            for user in client.get("/api/v1/admin/users").json()["users"]
        }
        assert "carol" not in names


def test_password_policy_is_enforced_wherever_a_password_is_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with _client(monkeypatch, database_auth=True) as client:
        _login_admin(client)
        short = client.post(
            "/api/v1/admin/users",
            json={"userId": "dave", "username": "dave", "password": "short"},
        )
        assert short.status_code == 400, short.text
        assert "8 characters" in short.json()["detail"]

        long = client.post(
            "/api/v1/admin/users",
            json={"userId": "erin", "username": "erin", "password": "x" * 257},
        )
        assert long.status_code == 400, long.text

        ok = client.post(
            "/api/v1/admin/users",
            json={"userId": "dave", "username": "dave", "password": "userpass"},
        )
        assert ok.status_code == 201, ok.text


def test_user_carries_a_handle_not_a_uuid(monkeypatch: pytest.MonkeyPatch) -> None:
    """`id` is a UUID under the database store; the handle is what admins read."""
    with _client(monkeypatch, database_auth=True) as client:
        _login_admin(client)
        created = _create_user(client, "alice", displayName="Alice Chen")
        assert created["handle"] == "alice"
        assert created["id"] != "alice"

        listed = {
            user["id"]: user
            for user in client.get("/api/v1/admin/users").json()["users"]
        }
        assert listed[created["id"]]["handle"] == "alice"


def test_handle_lookup_catches_a_collision_the_uuid_mapping_would_miss(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A row whose handle was backfilled has an id that is NOT uuid5 of it, so
    resolution consults the handle column before falling back to the mapping."""
    with _client(monkeypatch, database_auth=True) as client:
        _login_admin(client)
        alice = _create_user(client, "alice")

        store = DatabaseAccountAuthStore(os.environ["RELAY_DATABASE_URL"])
        with store.engine.begin() as connection:
            connection.execute(
                store.users.update()
                .where(store.users.c.id == alice["id"])
                .values(handle="ally")
            )

        assert store.resolve_user_id("ally") == alice["id"]
        clash = client.post(
            "/api/v1/admin/users",
            json={"userId": "ally", "username": "ally", "password": "userpass"},
        )
        assert clash.status_code == 409, clash.text
