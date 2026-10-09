from __future__ import annotations

from types import SimpleNamespace

from relay import cli


def test_cli_never_logs_bootstrap_token_and_uses_trusted_proxy_list(
    monkeypatch, tmp_path
) -> None:
    secret = "bootstrap-secret-that-must-not-be-logged"
    messages: list[str] = []
    uvicorn_options: dict[str, object] = {}
    app = SimpleNamespace(
        state=SimpleNamespace(auth_store=SimpleNamespace(has_users=lambda: False))
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
