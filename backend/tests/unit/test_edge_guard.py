from __future__ import annotations

from tempfile import TemporaryDirectory

import pytest
from fastapi.testclient import TestClient
from relay.app import create_app
from relay.core import deploy_config
from relay.security.edge import EDGE_SECRET_HEADER, client_ip, edge_request_verified
from starlette.requests import Request

SECRET = "s" * 40
NEXT_SECRET = "n" * 40


@pytest.fixture(autouse=True)
def clear_edge_env(monkeypatch) -> None:
    for name in ("RELAY_EDGE_SECRET", "RELAY_CLIENT_IP_HEADER"):
        monkeypatch.delenv(name, raising=False)


def _request(headers: dict[str, str], peer: str = "10.0.0.1") -> Request:
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()],
        "client": (peer, 1234),
    })


class TestEdgeConfig:
    def test_disabled_by_default(self) -> None:
        assert deploy_config.edge_secrets() == ()
        assert deploy_config.client_ip_header() is None

    def test_secrets_split_for_rotation(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_EDGE_SECRET", f"{SECRET}, {NEXT_SECRET} ,")
        assert deploy_config.edge_secrets() == (SECRET, NEXT_SECRET)

    def test_short_secret_is_rejected(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_EDGE_SECRET", "too-short")
        with pytest.raises(RuntimeError, match="at least 32"):
            deploy_config.edge_secrets()

    def test_client_ip_header_requires_edge_secret(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_CLIENT_IP_HEADER", "CF-Connecting-IP")
        with pytest.raises(RuntimeError, match="RELAY_EDGE_SECRET"):
            deploy_config.client_ip_header()

    def test_client_ip_header_is_normalized(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_EDGE_SECRET", SECRET)
        monkeypatch.setenv("RELAY_CLIENT_IP_HEADER", " CF-Connecting-IP ")
        assert deploy_config.client_ip_header() == "cf-connecting-ip"

    def test_invalid_header_name_is_rejected(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_EDGE_SECRET", SECRET)
        monkeypatch.setenv("RELAY_CLIENT_IP_HEADER", "bad header")
        with pytest.raises(RuntimeError, match="header name"):
            deploy_config.client_ip_header()


class TestClientIp:
    def test_uses_socket_peer_without_configuration(self) -> None:
        request = _request({"CF-Connecting-IP": "203.0.113.9"})
        assert client_ip(request) == "10.0.0.1"

    def test_uses_edge_header_on_verified_request(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_EDGE_SECRET", SECRET)
        monkeypatch.setenv("RELAY_CLIENT_IP_HEADER", "CF-Connecting-IP")
        request = _request({EDGE_SECRET_HEADER: SECRET, "CF-Connecting-IP": "203.0.113.9"})
        assert edge_request_verified(request.headers)
        assert client_ip(request) == "203.0.113.9"

    def test_ignores_edge_header_without_the_secret(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_EDGE_SECRET", SECRET)
        monkeypatch.setenv("RELAY_CLIENT_IP_HEADER", "CF-Connecting-IP")
        request = _request({EDGE_SECRET_HEADER: "wrong", "CF-Connecting-IP": "203.0.113.9"})
        assert not edge_request_verified(request.headers)
        assert client_ip(request) == "10.0.0.1"

    def test_ignores_a_header_that_is_not_an_ip(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_EDGE_SECRET", SECRET)
        monkeypatch.setenv("RELAY_CLIENT_IP_HEADER", "CF-Connecting-IP")
        request = _request({EDGE_SECRET_HEADER: SECRET, "CF-Connecting-IP": "1.2.3.4, 5.6.7.8"})
        assert client_ip(request) == "10.0.0.1"

    def test_normalizes_ipv6(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_EDGE_SECRET", SECRET)
        monkeypatch.setenv("RELAY_CLIENT_IP_HEADER", "CF-Connecting-IP")
        request = _request({EDGE_SECRET_HEADER: SECRET, "CF-Connecting-IP": "2001:DB8::0001"})
        assert client_ip(request) == "2001:db8::1"

    def test_accepts_the_rotating_secret(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_EDGE_SECRET", f"{SECRET},{NEXT_SECRET}")
        assert edge_request_verified(_request({EDGE_SECRET_HEADER: NEXT_SECRET}).headers)


class TestEdgeOriginGuard:
    def _client(self, monkeypatch, root: str) -> TestClient:
        monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
        monkeypatch.setenv("RELAY_EDGE_SECRET", SECRET)
        return TestClient(create_app(root))

    def test_rejects_requests_that_bypass_the_edge(self, monkeypatch) -> None:
        with TemporaryDirectory() as root:
            client = self._client(monkeypatch, root)
            response = client.get("/api/v1/auth/status")
            assert response.status_code == 403

    def test_admits_requests_carrying_the_secret(self, monkeypatch) -> None:
        with TemporaryDirectory() as root:
            client = self._client(monkeypatch, root)
            response = client.get("/api/v1/auth/status", headers={EDGE_SECRET_HEADER: SECRET})
            assert response.status_code == 200

    def test_health_check_stays_open(self, monkeypatch) -> None:
        with TemporaryDirectory() as root:
            client = self._client(monkeypatch, root)
            assert client.get("/healthz").status_code == 200

    def test_no_guard_without_configuration(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
        with TemporaryDirectory() as root:
            client = TestClient(create_app(root))
            assert client.get("/api/v1/auth/status").status_code == 200

    def test_invalid_configuration_fails_before_startup(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_CLIENT_IP_HEADER", "CF-Connecting-IP")
        with TemporaryDirectory() as root, pytest.raises(RuntimeError, match="RELAY_EDGE_SECRET"):
            create_app(root)

    def test_login_rate_limit_keys_on_the_edge_client_ip(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_AUTH_RATE_LIMIT_ATTEMPTS", "2")
        monkeypatch.setenv("RELAY_AUTH_RATE_LIMIT_WINDOW_SECONDS", "60")
        monkeypatch.setenv("RELAY_CLIENT_IP_HEADER", "CF-Connecting-IP")
        with TemporaryDirectory() as root:
            client = self._client(monkeypatch, root)

            def login(ip: str) -> int:
                return client.post(
                    "/api/v1/auth/login",
                    json={"username": "admin", "password": "wrong-password"},
                    headers={EDGE_SECRET_HEADER: SECRET, "CF-Connecting-IP": ip},
                ).status_code

            assert [login("203.0.113.1") for _ in range(3)][-1] == 429
            # Every client reaches the backend from the same edge peer; a second
            # client must not inherit the first one's lockout.
            assert login("203.0.113.2") != 429
