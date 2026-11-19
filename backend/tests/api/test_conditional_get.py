from __future__ import annotations

from datetime import UTC, datetime, timedelta
from hashlib import sha256

from fastapi.testclient import TestClient
from relay.api.conditional_get import POLLED_LISTS, etag_matches, weak_etag
from relay.app import create_app
from relay.persistence.events import relay_event


def _client(monkeypatch, tmp_path) -> TestClient:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    client = TestClient(create_app(str(tmp_path / "state")))
    assert client.post(
        "/api/v1/auth/bootstrap",
        json={"token": "admin_token", "username": "admin", "email": "admin@example.com", "password": "kestrel-vault-7719"},
    ).status_code == 200
    return client


def test_an_unchanged_polled_list_answers_304(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    for path in sorted(POLLED_LISTS):
        first = client.get(path)
        assert first.status_code == 200, path
        etag = first.headers["etag"]
        assert etag.startswith('W/"'), path
        # Stored by the browser and revalidated, never served stale.
        assert first.headers["cache-control"] == "private, no-cache", path
        again = client.get(path, headers={"If-None-Match": etag})
        assert again.status_code == 304, path
        assert again.content == b""
        assert again.headers["etag"] == etag


def test_a_changed_list_answers_200_with_a_new_etag(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    before = client.get("/api/v1/tasks")
    assert client.post("/api/v1/tasks", json={"title": "Write the brief"}).status_code == 201
    after = client.get("/api/v1/tasks", headers={"If-None-Match": before.headers["etag"]})
    assert after.status_code == 200
    assert after.headers["etag"] != before.headers["etag"]
    assert [task["title"] for task in after.json()["tasks"]] == ["Write the brief"]


def test_thread_detail_revalidates_without_storing_transcripts_in_http_cache(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    thread = client.post("/api/v1/threads", json={"taskGoal": "Write the brief"}).json()
    thread_id = thread["id"]
    path = f"/api/v1/threads/{thread_id}"
    compact = f"{path}?view=transcript"
    store = client.app.state.session_store
    output = "\n".join(f"Earlier output {sha256(str(line).encode()).hexdigest()}" for line in range(2048))
    store.append_event(thread_id, relay_event("agent.started", thread_id, {"runId": "run", "agent": "codex"}))
    store.append_event(thread_id, relay_event("agent.output", thread_id, {
        "runId": "run", "agent": "codex", "stream": "stdout", "text": output, "sequence": 0,
    }))
    store.append_event(thread_id, relay_event("agent.completed", thread_id, {
        "runId": "run", "agent": "codex", "agentLog": output, "status": "completed", "exitCode": 0,
    }))
    full = client.get(path)
    before = client.get(compact)
    assert before.status_code == 200
    assert before.headers["cache-control"] == "no-store"
    original = before.json()
    assert original["events"] == full.json()["events"]
    assert "agentLog" not in original["agentRuns"][0]
    assert full.json()["agentRuns"][0]["agentLog"] == output
    headers = {
        "If-None-Match": before.headers["etag"],
        "X-Relay-Thread-Events": f"0:{len(original['events'])}:{original['eventsRevision']}",
    }
    unchanged = client.get(compact, headers=headers)
    assert unchanged.status_code == 304
    assert unchanged.content == b""
    assert unchanged.headers["cache-control"] == "no-store"

    assert client.post(
        f"{path}/queue", json={"action": "enqueue", "id": "message", "text": "A follow-up"},
    ).status_code == 200
    changed = client.get(compact, headers=headers)
    assert changed.status_code == 200
    assert changed.headers["etag"] != headers["If-None-Match"]
    delta = changed.json()
    assert delta["messageQueue"]["messages"][0]["text"] == "A follow-up"
    assert delta["eventOffset"] == len(original["events"])
    assert [event["type"] for event in delta["events"]] == ["session.queue"]
    assert len(changed.content) < len(before.content) // 10
    assert int(changed.headers["content-length"]) < int(before.headers["content-length"]) // 10

    store.compact_completed_run_output(older_than=datetime.now(UTC) + timedelta(minutes=1))
    rewritten = client.get(compact, headers={
        "If-None-Match": changed.headers["etag"],
        "X-Relay-Thread-Events": f"0:{delta['eventCount']}:{delta['eventsRevision']}",
    })
    assert rewritten.status_code == 200
    assert rewritten.json()["eventOffset"] == 0
    assert any(event.get("compacted") for event in rewritten.json()["events"])

    client.post("/api/v1/auth/logout")
    rejected = client.get(compact, headers={"If-None-Match": changed.headers["etag"]})
    assert rejected.status_code == 401
    assert "etag" not in rejected.headers


def test_cold_transcript_load_reads_a_bounded_tail_and_pages_back(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    thread_id = client.post("/api/v1/threads", json={"taskGoal": "Long running thread"}).json()["id"]
    store = client.app.state.session_store
    expected = [event["id"] for event in store.get_session(thread_id)["events"]]
    for index in range(24):
        event = relay_event("agent.output", thread_id, {
            "runId": "agent", "agent": "codex", "stream": "stdout",
            "text": f"{index} " + "x" * 48_000, "sequence": index,
        })
        store.append_event(thread_id, event, hydrate_events=False)
        expected.append(event["id"])

    def reject_full_read(_session_id):
        raise AssertionError("the paged transcript must skip full event hydration")

    monkeypatch.setattr(store, "get_session", reject_full_read)
    path = f"/api/v1/threads/{thread_id}?view=transcript"
    tail = client.get(path)
    assert tail.status_code == 200
    assert len(tail.content) < 400_000
    page = tail.json()
    assert 0 < page["eventStart"] < page["eventCount"]
    assert page["eventCount"] == len(expected)
    event_ids = [event["id"] for event in page["events"]]
    assert event_ids[-1] == expected[-1]
    while page["eventStart"]:
        page_start = page["eventStart"]
        older = client.get(f"{path}&before={page_start}")
        assert older.status_code == 200
        assert len(older.content) < 400_000
        page = older.json()
        assert page["eventStart"] < page_start
        event_ids = [event["id"] for event in page["events"]] + event_ids
    assert event_ids == expected


def test_unlisted_and_secret_bearing_routes_stay_no_store(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    sandboxes = client.get("/api/v1/sandboxes")
    assert sandboxes.headers["cache-control"] == "no-store"
    assert "etag" not in sandboxes.headers
    # Errors are never cached either.
    client.post("/api/v1/auth/logout")
    rejected = client.get("/api/v1/tasks")
    assert rejected.status_code == 401
    assert "etag" not in rejected.headers
    assert rejected.headers["cache-control"] == "no-store"


def test_weak_comparison_accepts_either_form_and_lists():
    etag = weak_etag(b"{}")
    assert etag_matches(etag, etag)
    assert etag_matches(etag[2:], etag)
    assert etag_matches(b'W/"other", ' + etag, etag)
    assert etag_matches(b"*", etag)
    assert not etag_matches(b'W/"other"', etag)
