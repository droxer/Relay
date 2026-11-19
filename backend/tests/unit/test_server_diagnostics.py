"""Signal evidence must survive the normal Uvicorn shutdown path."""
import logging
import signal
from unittest.mock import Mock

from relay.bootstrap import server


def test_server_logs_signal_and_preserves_shutdown_behavior(monkeypatch):
    log = Mock()
    monkeypatch.setattr(server, "logger", log)
    instance = server.DiagnosticServer(server.uvicorn.Config("unused:app"))
    instance.handle_exit(signal.SIGTERM, None)
    assert instance.should_exit
    assert log.info.call_args.kwargs["signal"] == "SIGTERM"
    assert log.info.call_args.kwargs["reason"] == "signal; platform cause unknown"


def test_server_preserves_nonzero_exit_on_startup_failure(monkeypatch):
    import pytest
    instance = Mock(started=False)
    monkeypatch.setattr(server, "DiagnosticServer", lambda config: instance)
    with pytest.raises(SystemExit) as error:
        server.run_server("unused:app")
    assert error.value.code == 3


def test_access_logs_omit_connection_oauth_callback_parameters():
    filter_ = server.ConnectionCallbackLogFilter()
    for path, expected in (
        ("/api/v1/connections/callback/gmail?code=private&state=private", "/api/v1/connections/callback/gmail"),
        ("/api/v1/connections/callback/outlook?error_description=private", "/api/v1/connections/callback/outlook"),
        ("/api/v1/tasks?view=summary", "/api/v1/tasks?view=summary"),
    ):
        entry = logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d',
            ("127.0.0.1", "GET", path, "1.1", 303), None)
        assert filter_.filter(entry)
        assert entry.args[2] == expected
