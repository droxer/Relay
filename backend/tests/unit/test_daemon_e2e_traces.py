"""Trace polling must tolerate a writer paused in the middle of a record."""
import json

import pytest

from daemon_e2e import DaemonE2E


@pytest.mark.parametrize("partial_utf8", [False, True])
def test_trace_polling_waits_for_complete_record(tmp_path, partial_utf8):
    harness = DaemonE2E.__new__(DaemonE2E)
    harness.root = tmp_path
    assert harness.traces() == []
    path = tmp_path / "trace.jsonl"
    first = b'{"kind":"registered"}\n'
    second = '{"kind":"info","message":"云电脑"}\n'.encode()
    # A snapshot can even end inside a multibyte UTF-8 character.
    cut = second.index("云".encode()) + (1 if partial_utf8 else 0)
    path.write_bytes(first + second[:cut])
    assert harness.traces() == [{"kind": "registered"}]
    with path.open("ab") as writer:
        writer.write(second[cut:])
    assert harness.traces() == [
        {"kind": "registered"}, {"kind": "info", "message": "云电脑"},
    ]


def test_trace_polling_does_not_hide_corrupt_complete_records(tmp_path):
    harness = DaemonE2E.__new__(DaemonE2E)
    harness.root = tmp_path
    (tmp_path / "trace.jsonl").write_text('{"kind":broken}\n')
    with pytest.raises(json.JSONDecodeError):
        harness.traces()
