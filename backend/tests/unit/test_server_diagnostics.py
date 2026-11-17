"""Signal evidence must survive the normal Uvicorn shutdown path."""
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
