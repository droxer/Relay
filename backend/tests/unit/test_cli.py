from __future__ import annotations

from types import SimpleNamespace

from relay import cli
import pytest
from unittest.mock import AsyncMock


def test_cli_never_logs_bootstrap_token_and_uses_trusted_proxy_list(
    monkeypatch, tmp_path
) -> None:
    secret = "bootstrap-secret-that-must-not-be-logged"
    messages: list[str] = []
    uvicorn_options: dict[str, object] = {}
    app = SimpleNamespace(
        state=SimpleNamespace(auth_store=SimpleNamespace(has_accounts=lambda: False))
    )

    monkeypatch.setenv("RELAY_ADMIN_TOKEN", secret)
    monkeypatch.setenv("RELAY_TRUST_PROXY_HEADERS", "1")
    monkeypatch.setenv("RELAY_FORWARDED_ALLOW_IPS", "10.0.0.0/8")
    monkeypatch.setattr(cli, "create_app", lambda _root: app)
    monkeypatch.setattr(cli, "setup_logging", lambda: None)
    monkeypatch.setattr(
        cli.logger,
        "info",
        lambda message, *args, **kwargs: messages.append(message.format(*args)),
    )
    monkeypatch.setattr(
        cli.uvicorn,
        "run",
        lambda _app, **kwargs: uvicorn_options.update(kwargs),
    )

    cli.main(["serve", "--data-dir", str(tmp_path)])

    assert secret not in "\n".join(messages)
    assert uvicorn_options["proxy_headers"] is True
    assert uvicorn_options["forwarded_allow_ips"] == "10.0.0.0/8"


def test_agent_computer_id_check_prints_the_read_only_report(
    monkeypatch, capsys
) -> None:
    seen: list[str] = []
    monkeypatch.setattr(cli, "setup_logging", lambda: None)
    monkeypatch.setattr(
        cli, "database_url_from_env", lambda setting: "sqlite:///check.db"
    )
    monkeypatch.setattr(
        cli,
        "check_agent_computer_ids",
        lambda url: seen.append(url)
        or {"agents": [], "placements": [], "converged": True},
    )

    cli.main(["check-agent-computer-ids"])

    assert seen == ["sqlite:///check.db"]
    assert '"converged": true' in capsys.readouterr().out


def test_storage_report_command_prints_the_read_only_report(
    monkeypatch, capsys
) -> None:
    seen: list[str] = []
    monkeypatch.setattr(cli, "setup_logging", lambda: None)
    monkeypatch.setattr(
        cli, "database_url_from_env", lambda setting: "sqlite:///report.db"
    )
    monkeypatch.setattr(
        cli,
        "storage_report",
        lambda url: seen.append(url) or {"tables": [], "inlineContent": {}},
    )

    cli.main(["storage-report"])

    assert seen == ["sqlite:///report.db"]
    assert '"inlineContent"' in capsys.readouterr().out


@pytest.mark.parametrize("command", ["worker", "worker-schema"])
def test_worker_commands_do_not_start_an_http_server(monkeypatch, command, tmp_path):
    from relay import background
    worker, schema = AsyncMock(), AsyncMock()
    monkeypatch.setattr(background, "run_worker", worker)
    monkeypatch.setattr(background, "apply_worker_schema", schema)
    monkeypatch.setattr(cli, "setup_logging", lambda: None)
    monkeypatch.setattr(cli, "create_app", lambda *args: pytest.fail("HTTP application startup"))
    cli.main([command, "--data-dir", str(tmp_path)])
    if command == "worker":
        worker.assert_awaited_once_with(str(tmp_path))
        schema.assert_not_awaited()
    else:
        schema.assert_awaited_once()
        worker.assert_not_awaited()


def test_combined_command_delegates_to_supervisor_and_returns_its_exit_code(monkeypatch, tmp_path):
    from relay import processes
    supervisor = AsyncMock(return_value=7)
    monkeypatch.setattr(processes, "serve_with_worker", supervisor)
    monkeypatch.setattr(cli, "setup_logging", lambda: None)
    monkeypatch.setattr(cli, "create_app", lambda *args: pytest.fail("parent started an HTTP app"))
    with pytest.raises(SystemExit) as exit:
        cli.main(["serve-with-worker", "--host", "0.0.0.0", "--port", "9001", "--data-dir", str(tmp_path)])
    assert exit.value.code == 7
    supervisor.assert_awaited_once_with(host="0.0.0.0", port=9001, data_dir=str(tmp_path))
