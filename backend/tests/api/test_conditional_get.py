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


def test_web_computer_inventory_revalidates_while_only_age_changes(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    owner = client.get("/api/v1/auth/me").json()["user"]["userId"]
    registration = client.post("/api/v1/daemon-node-registrations", json={
        "sandboxId": "etag-node", "userId": owner, "token": "etag-node-token",
        "workspacePath": "/etag-workspace", "protocolVersion": 1, "status": "ready",
    })
    assert registration.status_code == 200, registration.text

    registry = client.app.state.registry
    liveness = registry._liveness
    monkeypatch.setattr(registry, "_liveness", lambda node: {**liveness(node), "lastSeenAgeMs": 1})
    legacy = client.get("/api/v1/daemon-nodes")
    assert legacy.json()["nodes"][0]["lastSeenAgeMs"] == 1
    projected = client.get("/api/v1/daemon-nodes?view=web")
    [node] = projected.json()["nodes"]
    assert node["lastSeenAt"]
    assert "lastSeenAgeMs" not in node
    assert "lastPollAgeMs" not in node

    monkeypatch.setattr(registry, "_liveness", lambda node: {**liveness(node), "lastSeenAgeMs": 2})
    headers = {"If-None-Match": projected.headers["etag"]}
    assert client.get("/api/v1/daemon-nodes?view=web", headers=headers).status_code == 304

    monkeypatch.setattr(registry, "_liveness", lambda node: {
        **liveness(node), "lastSeenAgeMs": 60001, "online": False, "stale": True,
    })
    changed = client.get("/api/v1/daemon-nodes?view=web", headers=headers)
    assert changed.status_code == 200
    assert changed.json()["nodes"][0]["online"] is False


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
    start = relay_event("agent.started", thread_id, {"runId": "agent", "agent": "codex", "brief": "Dispatch-only instructions"})
    store.append_event(thread_id, start, hydrate_events=False)
    expected.append(start["id"])
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
    legacy = client.get(path)
    tail = client.get(f"{path}&window=compact")
    assert tail.status_code == 200
    assert len(tail.content) < 150_000
    assert len(tail.content) < len(legacy.content) // 2
    page = tail.json()
    assert legacy.json()["agentRuns"][0]["brief"] == "Dispatch-only instructions"
    assert "brief" not in page["agentRuns"][0]
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


def test_browser_validator_revalidates_with_a_simple_get(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    path = "/api/v1/threads"
    initial = client.get(path, params={"view": "summary"})
    unchanged = client.get(path, params={
        "view": "summary", "relayRevision": initial.headers["etag"],
    })
    assert unchanged.status_code == 304
    assert unchanged.content == b""
    client.post("/api/v1/auth/logout")
    assert client.get(path, params={"relayRevision": initial.headers["etag"]}).status_code == 401


def test_unchanged_thread_page_skips_building_summaries(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    client.post("/api/v1/threads", json={"taskGoal": "Write the brief"})
    path = "/api/v1/threads?view=summary&limit=20&include=activity"
    initial = client.get(path)
    validator = {"If-None-Match": initial.headers["etag"]}

    def unexpected_page(**_kwargs):
        raise AssertionError("An unchanged thread list must skip building summaries")

    with monkeypatch.context() as scoped:
        scoped.setattr(client.app.state.session_store, "list_session_summary_page", unexpected_page)
        assert client.get(path, headers=validator).status_code == 304

    task = client.post("/api/v1/tasks", json={"title": "Needs review"}).json()
    client.app.state.task_store.update_task(task["id"], {"status": "review"})
    activity_changed = client.get(path, headers=validator)
    assert activity_changed.status_code == 200
    assert activity_changed.json()["homeTaskNeedsYou"] == 1

    assert client.post("/api/v1/threads", json={"taskGoal": "New thread"}).status_code == 201
    assert client.get(path, headers={"If-None-Match": activity_changed.headers["etag"]}).status_code == 200
