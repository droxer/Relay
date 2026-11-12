"""Cross-language regression coverage; build the daemon packages before running."""
import json
import subprocess
from uuid import uuid4

import pytest

from daemon_e2e import DaemonE2E, eventually
from daemon_e2e import ROOT
from relay.daemon_registry.records import CommandEventMismatchError


@pytest.fixture
def real_daemon(tmp_path, monkeypatch):
    harness = DaemonE2E(tmp_path, monkeypatch)
    try:
        harness.setup()
        yield harness
    finally:
        harness.close()


@pytest.mark.integration
def test_completed_task_thread_accepts_followups_and_report_replays(real_daemon):
    h = real_daemon
    task_id, session_id = h.start_task()
    h.settled(session_id, 1)
    for index in range(20):
        h.fault("ack-loss" if index % 2 else "duplicate")
        h.follow_up(session_id, f"Follow up {index}")
        h.settled(session_id, index + 2)
        assert h.client.get(f"/api/v1/tasks/{task_id}").json()["status"] == "done"
    traces = h.traces()
    assert len([item for item in traces if item["kind"] == "launch"]) == 21
    assert len([item for item in traces if item["kind"] == "ack-loss"]) == 10
    assert len([item for item in traces if item["kind"] == "duplicate"]) == 10
    events = h.ctx.session_store.get_session(session_id)["events"]
    text = json.dumps([item for item in events if item["type"] in {"agent.output", "agent.output.batch"}])
    for launch in [item for item in traces if item["kind"] == "launch"]:
        for index in range(8):
            assert text.count(f"E2E reply {index} for {launch['runId']}") == 1


@pytest.mark.integration
@pytest.mark.parametrize("failure", [ValueError, TypeError, KeyError])
def test_processing_fault_rolls_back_then_real_daemon_replays(real_daemon, monkeypatch, failure):
    h = real_daemon
    original = h.ctx.registry.handle_durable_report
    injected = []

    def fail_after_write(node_id, event, *args):
        original(node_id, event, *args)
        if not injected and event["type"] in {"run.output", "run.output.batch"}:
            injected.append(event)
            raise failure("Injected after SQL write; must rollback and retry")

    monkeypatch.setattr(h.ctx.registry, "handle_durable_report", fail_after_write)
    task_id, session_id = h.start_task()
    h.settled(session_id, 1)
    assert injected
    assert any(receipt["status"] == 500 for trace in h.traces() for receipt in trace.get("receipts", []))
    assert h.client.get(f"/api/v1/tasks/{task_id}").json()["status"] == "done"
    h.follow_up(session_id)
    h.settled(session_id, 2)
    events = h.ctx.session_store.get_session(session_id)["events"]
    text = json.dumps([item for item in events if item["type"] in {"agent.output", "agent.output.batch"}])
    run_id = next(item["runId"] for item in h.traces() if item["kind"] == "launch")
    for index in range(8):
        assert text.count(f"E2E reply {index} for {run_id}") == 1


@pytest.mark.integration
def test_cancel_followup_restart_and_deleted_thread_stop(real_daemon):
    h = real_daemon
    hold = h.root / "hold"
    hold.touch()
    _, session_id = h.start_task()
    eventually(lambda: any(item["kind"] == "launch" for item in h.traces()))
    h.post(f"/threads/{session_id}/cancellations", {"reason": "E2E stop"}, 202)
    h.settled(session_id, 1, "cancelled")
    hold.unlink()
    h.follow_up(session_id)
    h.settled(session_id, 2)
    h.stop_daemon()
    h.start_daemon()
    eventually(lambda: len([item for item in h.traces() if item["kind"] == "registered"]) == 2)
    h.follow_up(session_id)
    h.settled(session_id, 3)
    h.stop_daemon()
    launch = [item for item in h.traces() if item["kind"] == "launch"][-1]
    record = h.ctx.daemon_store.get_command(launch["commandId"])
    # A delayed Stop may outlive the user's thread deletion. Keep the original
    # command (the separate orphan tests cover retention pruning it).
    response = h.client.delete(f"/api/v1/threads/{session_id}")
    assert response.status_code == 204, response.text
    cancel = {"id": str(uuid4()), "type": "run.cancel", "commandId": launch["commandId"],
        "sessionId": session_id, "runId": launch["runId"], "agent": "codex", "reason": "Delayed E2E stop",
        "targetLeaseId": record["leaseId"]}
    h.ctx.daemon_store.enqueue_command(h.node_id, cancel)
    h.start_daemon()
    eventually(lambda: h.ctx.daemon_store.get_command(cancel["id"])["status"] == "completed")
    eventually(lambda: not list((h.root / "state").rglob("terminal-events/*.json")))
    assert not list((h.root / "state").rglob("*.rejected"))
    assert len([item for item in h.traces() if item["kind"] == "launch"]) == 3


@pytest.mark.integration
def test_restart_replays_retained_terminal_without_executing_again(real_daemon):
    h = real_daemon
    h.fault("offline-terminal")
    task_id, session_id = h.start_task()
    eventually(lambda: any(item["kind"] == "offline-terminal" for item in h.traces()))
    h.stop_daemon()
    assert list((h.root / "state").rglob("terminal-events/*.json"))
    h.fault("none")
    h.start_daemon()
    h.settled(session_id, 1)
    assert h.client.get(f"/api/v1/tasks/{task_id}").json()["status"] == "done"
    h.follow_up(session_id)
    h.settled(session_id, 2)


@pytest.mark.integration
def test_permanent_rejection_survives_restart_until_audited_retry(real_daemon, monkeypatch):
    h = real_daemon
    original = h.ctx.registry.handle_durable_report

    def refuse_terminal(node_id, event, *args):
        if event["type"] == "run.completed":
            raise CommandEventMismatchError("E2E deliberate permanent refusal")
        return original(node_id, event, *args)

    monkeypatch.setattr(h.ctx.registry, "handle_durable_report", refuse_terminal)
    task_id, session_id = h.start_task()
    rejected = eventually(lambda: list((h.root / "state").rglob("*.rejected")))[0]
    h.stop_daemon()
    saved = rejected.read_text()
    assert json.loads(saved)["status"] == 409
    assert "E2E deliberate permanent refusal" in saved
    monkeypatch.setattr(h.ctx.registry, "handle_durable_report", original)
    h.start_daemon()
    eventually(lambda: len([item for item in h.traces() if item["kind"] == "registered"]) == 2)
    assert rejected.read_text() == saved
    assert h.session(session_id)["status"] == "running"
    h.stop_daemon()
    subprocess.run(["node", str(ROOT / "packages/relay-daemon/tests/fixtures/report-e2e.mjs"),
        str(h.root / "profile.json"), "retry", rejected.stem], cwd=ROOT, check=True, timeout=10)
    assert not rejected.exists()
    audits = list(rejected.parent.glob("*.audit"))
    assert len(audits) == 1
    assert "E2E deliberate permanent refusal" in audits[0].read_text()
    h.start_daemon()
    h.settled(session_id, 1)
    assert h.client.get(f"/api/v1/tasks/{task_id}").json()["status"] == "done"
    h.follow_up(session_id)
    h.settled(session_id, 2)
