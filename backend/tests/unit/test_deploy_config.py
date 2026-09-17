from __future__ import annotations

import pytest
from relay.core import deploy_config
from relay.core.storage_config import normalize_database_url
from relay.security.auth import user_session_cookie_attrs, user_session_cookie_scope


@pytest.fixture(autouse=True)
def clear_deploy_env(monkeypatch) -> None:
    for name in (
        "RELAY_PUBLIC_BACKEND_URL",
        "RELAY_CORS_ALLOW_ORIGINS",
        "RELAY_CORS_ALLOW_ORIGIN_REGEX",
        "RELAY_SESSION_COOKIE_DOMAIN",
        "RELAY_SESSION_COOKIE_SAMESITE",
        "RELAY_FORCE_SECURE_COOKIES",
        "RELAY_TRUST_PROXY_HEADERS",
        "RELAY_FORWARDED_ALLOW_IPS",
        "BACKEND_HOST",
        "BACKEND_PORT",
        "HOST",
        "PORT",
    ):
        monkeypatch.delenv(name, raising=False)


class TestDatabaseUrlNormalization:
    @pytest.mark.parametrize(
        "raw",
        ["postgresql://relay:pw@db.internal:5432/relay", "postgres://relay:pw@db.internal:5432/relay"],
    )
    def test_provider_urls_pin_the_psycopg_driver(self, raw: str) -> None:
        assert normalize_database_url(raw) == "postgresql+psycopg://relay:pw@db.internal:5432/relay"

    def test_explicit_driver_and_other_backends_pass_through(self) -> None:
        assert normalize_database_url("postgresql+asyncpg://a/b") == "postgresql+asyncpg://a/b"
        assert normalize_database_url("postgresql+psycopg://a/b") == "postgresql+psycopg://a/b"
        assert normalize_database_url("sqlite:///relay.db") == "sqlite:///relay.db"


class TestCors:
    def test_disabled_by_default(self) -> None:
        assert deploy_config.cors_allow_origins() == []
        assert deploy_config.cors_allow_origin_regex() is None
        assert deploy_config.cors_enabled() is False

    def test_origins_are_split_and_trailing_slashes_dropped(self, monkeypatch) -> None:
        monkeypatch.setenv(
            "RELAY_CORS_ALLOW_ORIGINS", "https://a.example.com/, https://b.example.com ,",
        )
        assert deploy_config.cors_allow_origins() == [
            "https://a.example.com",
            "https://b.example.com",
        ]
        assert deploy_config.cors_enabled() is True

    def test_wildcard_origin_is_rejected(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_CORS_ALLOW_ORIGINS", "*")
        with pytest.raises(RuntimeError, match="cannot be '\\*'"):
            deploy_config.cors_allow_origins()

    def test_origin_regex_is_anchored(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_CORS_ALLOW_ORIGIN_REGEX", r"https://relay-.*\.vercel\.app")
        pattern = deploy_config.cors_allow_origin_regex()
        assert pattern is not None
        assert pattern.startswith("^") and pattern.endswith("$")

        import re

        compiled = re.compile(pattern)
        assert compiled.match("https://relay-abc123.vercel.app")
        # A suffix match from an attacker-controlled host must not be allowed.
        assert compiled.match("https://evil.com/?https://relay-abc.vercel.app") is None

    def test_invalid_origin_regex_is_reported(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_CORS_ALLOW_ORIGIN_REGEX", "https://(unclosed")
        with pytest.raises(RuntimeError, match="not a valid regular expression"):
            deploy_config.cors_allow_origin_regex()


class TestSessionCookieConfig:
    def test_defaults_match_the_single_origin_install(self) -> None:
        attrs = user_session_cookie_attrs(max_age_seconds=60)
        assert attrs["samesite"] == "lax"
        assert "domain" not in attrs
        assert "secure" not in attrs
        assert user_session_cookie_scope() == {}

    def test_domain_is_shared_by_set_and_delete(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_SESSION_COOKIE_DOMAIN", ".example.com")
        assert user_session_cookie_attrs(max_age_seconds=60)["domain"] == ".example.com"
        assert user_session_cookie_scope() == {"domain": ".example.com"}

    def test_cross_site_cookie_is_always_secure(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_SESSION_COOKIE_SAMESITE", "none")
        # An http request must not be able to downgrade a SameSite=None cookie
        # into one the browser silently drops.
        attrs = user_session_cookie_attrs(max_age_seconds=60, secure=False)
        assert attrs["samesite"] == "none"
        assert attrs["secure"] is True
        assert deploy_config.force_secure_cookies() is True

    def test_invalid_samesite_is_rejected(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_SESSION_COOKIE_SAMESITE", "sometimes")
        with pytest.raises(RuntimeError, match="must be one of"):
            deploy_config.session_cookie_samesite()

    def test_forced_secure_survives_a_plain_http_hop_from_the_load_balancer(
        self, monkeypatch
    ) -> None:
        assert deploy_config.cookie_is_secure("http") is False
        assert deploy_config.cookie_is_secure("https") is True
        monkeypatch.setenv("RELAY_FORCE_SECURE_COOKIES", "1")
        assert deploy_config.cookie_is_secure("http") is True


class TestBindConfig:
    def test_defaults_stay_on_loopback(self) -> None:
        assert deploy_config.bind_host() == "127.0.0.1"
        assert deploy_config.bind_port() == 8790
        assert deploy_config.trust_proxy_headers() is False

    def test_platform_port_is_used_when_relay_specific_name_is_absent(
        self, monkeypatch
    ) -> None:
        monkeypatch.setenv("PORT", "4321")
        monkeypatch.setenv("HOST", "0.0.0.0")
        assert deploy_config.bind_port() == 4321
        assert deploy_config.bind_host() == "0.0.0.0"

    def test_relay_specific_names_win(self, monkeypatch) -> None:
        monkeypatch.setenv("PORT", "4321")
        monkeypatch.setenv("BACKEND_PORT", "8790")
        monkeypatch.setenv("HOST", "0.0.0.0")
        monkeypatch.setenv("BACKEND_HOST", "127.0.0.1")
        assert deploy_config.bind_port() == 8790
        assert deploy_config.bind_host() == "127.0.0.1"

    def test_non_numeric_port_is_reported(self, monkeypatch) -> None:
        monkeypatch.setenv("PORT", "not-a-port")
        with pytest.raises(RuntimeError, match="must be an integer"):
            deploy_config.bind_port()

    def test_proxy_header_trust_can_be_disabled(self, monkeypatch) -> None:
        monkeypatch.setenv("RELAY_TRUST_PROXY_HEADERS", "0")
        assert deploy_config.trust_proxy_headers() is False

    def test_proxy_header_trust_requires_explicit_non_wildcard_proxies(
        self, monkeypatch
    ) -> None:
        monkeypatch.setenv("RELAY_TRUST_PROXY_HEADERS", "1")
        with pytest.raises(RuntimeError, match="RELAY_FORWARDED_ALLOW_IPS"):
            deploy_config.forwarded_allow_ips()

        monkeypatch.setenv(
            "RELAY_FORWARDED_ALLOW_IPS", "10.0.0.0/8, 192.168.1.10"
        )
        assert deploy_config.forwarded_allow_ips() == "10.0.0.0/8,192.168.1.10"

        monkeypatch.setenv("RELAY_FORWARDED_ALLOW_IPS", "*")
        with pytest.raises(RuntimeError, match="cannot contain"):
            deploy_config.forwarded_allow_ips()


class TestPublicBackendUrl:
    def test_optional_and_normalizes_trailing_slash(self, monkeypatch) -> None:
        monkeypatch.delenv("RELAY_PUBLIC_BACKEND_URL", raising=False)
        assert deploy_config.public_backend_url() is None
        monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", " https://api.example.com:8443/ ")
        assert deploy_config.public_backend_url() == "https://api.example.com:8443"

    @pytest.mark.parametrize("url", [
        "api.example.com", "http://api.example.com", "https://",
        "https://user:secret@api.example.com", "https://api.example.com/api/v1",
        "https://api.example.com?token=secret", "https://api.example.com#fragment",
        "https://api.example.com:bad", "https://api.example.com:99999",
        "https://api.example.com/\n", "https://api.example.com\\evil",
    ])
    def test_rejects_invalid_public_origins(self, monkeypatch, url) -> None:
        monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", url)
        with pytest.raises(RuntimeError, match="RELAY_PUBLIC_BACKEND_URL"):
            deploy_config.public_backend_url()

    @pytest.mark.parametrize("url", ["http://localhost:8790", "http://127.0.0.1:8790", "http://[::1]:8790"])
    def test_allows_http_loopback_for_development(self, monkeypatch, url) -> None:
        monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", url)
        assert deploy_config.public_backend_url() == url


def test_invalid_public_backend_url_fails_before_startup(monkeypatch, tmp_path) -> None:
    from relay.app import create_app

    monkeypatch.setenv("RELAY_PUBLIC_BACKEND_URL", "https://user:secret@api.example.com")
    with pytest.raises(RuntimeError, match="RELAY_PUBLIC_BACKEND_URL") as error:
        create_app(tmp_path)
    assert "secret" not in str(error.value)
