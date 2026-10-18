from __future__ import annotations

import pytest
from relay.core.settings import AppSettings, RegistrySettings, SettingsError, StreamSettings


def test_app_settings_defaults_from_an_empty_environment() -> None:
    settings = AppSettings.from_env({})

    assert settings.channels_enabled is False
    assert settings.waitlist_enabled is False
    assert settings.task_scheduler_enabled is True
    assert settings.task_scheduler_max_dispatches == 5
    assert settings.max_json_body_bytes == 4 * 1024 * 1024
    assert settings.waitlist_limit.attempts == 5
    assert settings.web_ui_dist_dir is None


def test_every_invalid_value_is_reported_together() -> None:
    with pytest.raises(SettingsError) as raised:
        AppSettings.from_env(
            {
                "RELAY_CHANNELS_ENABLED": "maybe",
                "RELAY_TASK_SCHEDULER_MAX_DISPATCHES": "0",
                "RELAY_WAITLIST_RATE_LIMIT_ATTEMPTS": "five",
                "RELAY_TASK_SCHEDULER_TIMEZONE": "Mars/Olympus",
            }
        )

    problems = " ".join(raised.value.problems)
    assert len(raised.value.problems) == 4
    for name in (
        "RELAY_CHANNELS_ENABLED",
        "RELAY_TASK_SCHEDULER_MAX_DISPATCHES",
        "RELAY_WAITLIST_RATE_LIMIT_ATTEMPTS",
        "RELAY_TASK_SCHEDULER_TIMEZONE",
    ):
        assert name in problems


def test_scheduler_today_uses_the_configured_zone() -> None:
    settings = AppSettings.from_env({"RELAY_TASK_SCHEDULER_TIMEZONE": "Pacific/Kiritimati"})

    assert settings.task_scheduler_timezone is not None
    assert settings.scheduler_today() is not None


def test_registry_rejects_a_heartbeat_persist_interval_past_the_liveness_timeout() -> None:
    with pytest.raises(SettingsError, match="LIVENESS_TIMEOUT"):
        RegistrySettings.from_env(
            {
                "RELAY_DAEMON_NODE_LIVENESS_TIMEOUT_MS": "4000",
                "RELAY_DAEMON_NODE_SEEN_PERSIST_INTERVAL_SECONDS": "5",
            }
        )


def test_registry_repair_budget_defaults_to_the_policy_value() -> None:
    assert RegistrySettings.from_env({}, default_max_repairs=1).run_max_repairs == 1
    assert RegistrySettings.from_env({"RELAY_DAEMON_RUN_MAX_REPAIRS": "0"}).run_max_repairs == 0


def test_stream_page_limit_is_bounded() -> None:
    with pytest.raises(SettingsError, match="RELAY_STREAM_EVENT_PAGE_LIMIT"):
        StreamSettings.from_env({"RELAY_STREAM_EVENT_PAGE_LIMIT": "5000"})
