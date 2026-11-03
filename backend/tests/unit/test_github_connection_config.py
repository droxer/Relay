import pytest

from relay.core.github_connection import github_config_from_env
from relay.core.settings import SettingsError

NAMES = ("CLIENT_ID", "CLIENT_SECRET", "APP_SLUG", "CALLBACK_URL", "ENCRYPTION_KEY")


def test_no_github_config_leaves_connections_disabled(monkeypatch):
    for name in NAMES:
        monkeypatch.delenv(f"RELAY_GITHUB_{name}", raising=False)
    assert github_config_from_env() is None


def test_incomplete_github_config_fails_without_exposing_secrets(monkeypatch):
    for name in NAMES:
        monkeypatch.delenv(f"RELAY_GITHUB_{name}", raising=False)
    monkeypatch.setenv("RELAY_GITHUB_CLIENT_SECRET", "secret-that-must-stay-private")
    with pytest.raises(SettingsError) as failure:
        github_config_from_env()
    assert "RELAY_GITHUB_CLIENT_ID" in str(failure.value)
    assert "secret-that-must-stay-private" not in str(failure.value)
