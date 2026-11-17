"""Focused regressions for durable background artifact indexing.

Completion now enqueues reported workspace files (snapshot bytes inline) in a
single durable batch instead of indexing each file in the request, so the
``run.completed`` request does a bounded number of storage transactions no
matter how many files a run reports, and a slow or blocked blob store cannot
stall completion acknowledgement, cancellation, or reads.
"""

from __future__ import annotations

import asyncio
import base64
import threading
from datetime import UTC, datetime
from tempfile import TemporaryDirectory
from typing import Any

import pytest
from sqlalchemy import event, update

from relay.daemon_registry.registry import DaemonNodeRegistry
from relay.daemon_registry.node_backend import ServerDaemonNodeBackend
from relay.execution.artifact_indexing import ArtifactIndexWorker
from relay.persistence.engine import store_transaction
from relay.persistence.session.artifact_indexing import ARTIFACT_INDEX_BATCH_LIMIT
from relay.persistence.session.store import DatabaseSessionStore
from blob_fakes import MemoryBlobStore
from store_fixtures import drain_artifact_indexing, make_daemon_store, make_session_store


def _register(registry: DaemonNodeRegistry, *, capabilities: list[str]) -> None:
    registry.register(
        {
            "sandboxId": "sbx_alice",
            "userId": "alice",
            "token": "node_token",
            "workspacePath": "/remote/workspace",
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": capabilities,
            "status": "ready",
        },
        "ui_token",
    )


def _pdf(relative: str, *, content: bytes = b"x") -> dict[str, Any]:
    return {
        "relativePath": relative,
        "title": relative.rsplit("/", 1)[-1],
        "bytes": len(content),
        "contentType": "application/pdf",
        "contentBase64": base64.b64encode(content).decode("ascii"),
    }


def test_completion_enqueues_once_never_indexes_inline() -> None:
    async def flow() -> None:
        with TemporaryDirectory() as root:
            session_store = make_session_store(root)
            registry = DaemonNodeRegistry(session_store, make_daemon_store(root))
            _register(registry, capabilities=["generated-files", "workspace-scope", "thread-workspaces"])
            session = await ServerDaemonNodeBackend(registry).run(
                "sbx_alice", {"taskGoal": "produce", "assignments": [{"agent": "codex"}]}
            )
            [command] = registry.take_commands("sbx_alice", "node_token")
            [request] = registry.daemon_store.list_active_run_requests("sbx_alice")

            indexed = []
            original = session_store.index_workspace_artifact
            session_store.index_workspace_artifact = (
                lambda *args, **kwargs: indexed.append(args) or original(*args, **kwargs)
            )
            enqueued = []
            original_enqueue = session_store.enqueue_workspace_artifacts
            session_store.enqueue_workspace_artifacts = (
                lambda *args, **kwargs: enqueued.append(args) or original_enqueue(*args, **kwargs)
            )

            # A single report is bounded by the daemon's own 200-file cap; the
            # completion path must enqueue it once, not index per file.
            event = {
                "runId": command["runId"],
                "generatedFiles": [_pdf(f"reports/{i}.pdf") for i in range(200)],
            }
            registry._record_generated_workspace_artifacts(
                registry.get("sbx_alice"), request, event, None, request["assignments"][0]
            )

            # The completion path never performs per-file indexing; it enqueues
            # once, in a single batch, whatever the report size.
            assert indexed == []
            assert len(enqueued) == 1
            assert len(enqueued[0][3]) == 200
            status = session_store.artifact_index_status(session["id"])
            assert status["pending"] == 1
            assert status["overflow"] == 0

    asyncio.run(flow())


def test_batch_cap_200_and_overflow_are_durable_and_counted() -> None:
    with TemporaryDirectory() as root:
        session_store = make_session_store(root)
        session = session_store.create_session(
            {"taskGoal": "produce", "workspacePath": "/ws", "ownerUserId": "alice"}
        )
        items = [
            {
                "id": f"art-{i}",
                "kind": "workspace_file",
                "title": f"{i}.pdf",
                "path": f"/ws/{i}.pdf",
                "createdAt": "2026-11-17T00:00:00.000Z",
                "agentRunId": "run-1",
                "bytes": 1,
                "contentType": "application/pdf",
                "workspaceRelativePath": f"{i}.pdf",
                "contentBase64": base64.b64encode(b"x").decode("ascii"),
            }
            for i in range(250)
        ]
        inserted = session_store.enqueue_workspace_artifacts(
            session["id"], "run-1", None, items
        )
        assert inserted == 2  # 200 + 50
        status = session_store.artifact_index_status(session["id"])
        assert status["pending"] == 2
        assert status["overflow"] == 50
        assert status["indexed"] == 0
        assert status["failed"] == 0
        # Re-enqueue is a no-op: the (session, run, sequence) identity is stable.
        assert session_store.enqueue_workspace_artifacts(session["id"], "run-1", None, items) == 0
        assert session_store.artifact_index_status(session["id"])["pending"] == 2


def test_worker_indexes_once_and_replay_creates_no_duplicates() -> None:
    with TemporaryDirectory() as root:
        session_store = make_session_store(root)
        session = session_store.create_session(
            {"taskGoal": "produce", "workspacePath": "/ws", "ownerUserId": "alice"}
        )
        items = [
            {
                "id": f"art-{i}",
                "kind": "workspace_file",
                "title": f"{i}.pdf",
                "path": f"/ws/{i}.pdf",
                "createdAt": "2026-11-17T00:00:00.000Z",
                "agentRunId": "run-1",
                "bytes": 2,
                "contentType": "application/pdf",
                "workspaceRelativePath": f"{i}.pdf",
                "contentBase64": base64.b64encode(b"ok").decode("ascii"),
            }
            for i in range(3)
        ]
        session_store.enqueue_workspace_artifacts(session["id"], "run-1", None, items)

        assert drain_artifact_indexing(session_store) == 1
        artifacts = session_store.get_session(session["id"])["artifacts"]
        assert sorted(a["workspaceRelativePath"] for a in artifacts) == ["0.pdf", "1.pdf", "2.pdf"]
        assert session_store.artifact_index_status(session["id"])["indexed"] == 1

        # Re-claiming (as a crashed indexer would after its lease expires) and
        # draining again must not duplicate artifacts or events.
        assert drain_artifact_indexing(session_store) == 0
        assert len(session_store.get_session(session["id"])["artifacts"]) == 3


def test_snapshot_survives_restart_and_rollback() -> None:
    with TemporaryDirectory() as root:
        store = make_session_store(root)
        session = store.create_session(
            {"taskGoal": "produce", "workspacePath": "/ws", "ownerUserId": "alice"}
        )
        store.enqueue_workspace_artifacts(
            session["id"],
            "run-1",
            None,
            [
                {
                    "id": "art-1",
                    "kind": "workspace_file",
                    "title": "a.pdf",
                    "path": "/ws/a.pdf",
                    "createdAt": "2026-11-17T00:00:00.000Z",
                    "agentRunId": "run-1",
                    "bytes": 4,
                    "contentType": "application/pdf",
                    "workspaceRelativePath": "a.pdf",
                    "contentBase64": base64.b64encode(b"data").decode("ascii"),
                }
            ],
        )

        # A fresh store over the same database sees the pending batch and its
        # inline snapshot bytes — a restart does not lose them.
        reopened = make_session_store(root)
        assert reopened.artifact_index_status(session["id"])["pending"] == 1
        assert drain_artifact_indexing(reopened) == 1
        artifact = reopened.get_session(session["id"])["artifacts"][0]
        assert reopened.read_artifact_content(session["id"], artifact["id"]) == b"data"


def test_blocked_snapshot_upload_does_not_block_completion_or_reads() -> None:
    async def flow() -> None:
        with TemporaryDirectory() as root:
            session_store = make_session_store(root)
            registry = DaemonNodeRegistry(session_store, make_daemon_store(root))
            _register(registry, capabilities=["generated-files", "workspace-scope", "thread-workspaces"])
            session = await ServerDaemonNodeBackend(registry).run(
                "sbx_alice", {"taskGoal": "produce", "assignments": [{"agent": "codex"}]}
            )
            [command] = registry.take_commands("sbx_alice", "node_token")

            entered = threading.Event()
            released = threading.Event()
            session_store.blob_store = _BlockingBlobStore(entered, released)

            # The completion request enqueues, never uploads, so it returns
            # (ACKs) even though the blob store would block forever.
            registry.handle_event(
                "sbx_alice",
                {
                    "type": "run.completed",
                    "commandId": command["id"],
                    "sessionId": command["sessionId"],
                    "runId": command["runId"],
                    "agent": "codex",
                    "exitCode": 0,
                    "agentLog": "done",
                    "generatedFiles": [_pdf(f"r/{i}.pdf", content=b"payload") for i in range(20)],
                },
                "node_token",
            )
            assert session_store.blob_store.puts == []
            assert session_store.artifact_index_status(session["id"])["pending"] == 1

            # The background worker uploads in its own thread and blocks on put.
            worker = ArtifactIndexWorker(session_store)
            result: dict[str, int] = {}
            index_thread = threading.Thread(target=lambda: result.setdefault("n", worker.tick()))
            index_thread.start()
            assert entered.wait(timeout=5), "upload never started blocking"

            # While the upload is blocked, the completion is already
            # acknowledged and unrelated reads and status queries progress.
            assert session_store.get_session(session["id"])["status"] == "completed"
            assert session_store.artifact_index_status(session["id"])["pending"] == 1

            released.set()
            index_thread.join(timeout=10)
            assert not index_thread.is_alive()
            assert result["n"] == 1
            assert session_store.artifact_index_status(session["id"])["indexed"] == 1
            assert len(session_store.blob_store.blobs) == 20

    asyncio.run(flow())


def test_worker_requeues_transient_failure_and_recovers() -> None:
    with TemporaryDirectory() as root:
        store = make_session_store(root)
        session = store.create_session(
            {"taskGoal": "produce", "workspacePath": "/ws", "ownerUserId": "alice"}
        )
        store.enqueue_workspace_artifacts(
            session["id"],
            "run-1",
            None,
            [
                {
                    "id": "art-1",
                    "kind": "workspace_file",
                    "title": "a.pdf",
                    "path": "/ws/a.pdf",
                    "createdAt": "2026-11-17T00:00:00.000Z",
                    "agentRunId": "run-1",
                    "bytes": 1,
                    "contentType": "application/pdf",
                    "workspaceRelativePath": "a.pdf",
                    "contentBase64": base64.b64encode(b"x").decode("ascii"),
                }
            ],
        )

        worker = ArtifactIndexWorker(store)
        original = store.index_workspace_artifact
        calls = {"n": 0}

        def flaky(*args: Any, **kwargs: Any) -> Any:
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("transient blob failure")
            return original(*args, **kwargs)

        store.index_workspace_artifact = flaky
        assert worker.tick() == 1  # fails and requeues
        status = store.artifact_index_status(session["id"])
        assert status["pending"] == 1 and status["failed"] == 0

        assert worker.tick() == 1  # succeeds on retry
        status = store.artifact_index_status(session["id"])
        assert status["pending"] == 0 and status["indexed"] == 1
        assert len(store.get_session(session["id"])["artifacts"]) == 1


class _BlockingBlobStore:
    """A blob store whose ``put`` really blocks until released.

    The prior fake only recorded the key and returned, so it could not prove
    that completion acknowledgement and unrelated reads proceed while an upload
    is genuinely stuck.
    """

    def __init__(self, entered: threading.Event, released: threading.Event) -> None:
        self.entered = entered
        self.released = released
        self.blobs: dict[str, bytes] = {}
        self.puts: list[str] = []

    def put(self, key: str, content: bytes, *, content_type: str | None = None) -> None:
        self.puts.append(key)
        self.entered.set()
        if not self.released.wait(timeout=10):
            raise RuntimeError("upload never released")
        self.blobs[key] = content

    def get(self, key: str) -> bytes | None:
        return self.blobs.get(key)

    def delete(self, key: str) -> None:
        self.blobs.pop(key, None)

    def delete_prefix(self, prefix: str) -> None:
        for key in [k for k in self.blobs if k.startswith(prefix)]:
            del self.blobs[key]


def test_handle_event_enqueues_in_terminal_handler_before_indexing() -> None:
    async def flow() -> None:
        with TemporaryDirectory() as root:
            session_store = make_session_store(root)
            registry = DaemonNodeRegistry(session_store, make_daemon_store(root))
            _register(registry, capabilities=["generated-files", "workspace-scope", "thread-workspaces"])
            session = await ServerDaemonNodeBackend(registry).run(
                "sbx_alice", {"taskGoal": "produce", "assignments": [{"agent": "codex"}]}
            )
            [command] = registry.take_commands("sbx_alice", "node_token")
            registry.handle_event(
                "sbx_alice",
                {
                    "type": "run.completed",
                    "commandId": command["id"],
                    "sessionId": command["sessionId"],
                    "runId": command["runId"],
                    "agent": "codex",
                    "exitCode": 0,
                    "agentLog": "done",
                    "generatedFiles": [_pdf("reports/a.pdf")],
                },
                "node_token",
            )
            # The terminal handler enqueued the file atomically with the exit
            # evidence; it has not been indexed yet (that is the worker's job).
            assert session_store.artifact_index_status(session["id"])["pending"] == 1
            assert session_store.get_session(session["id"])["artifacts"] == []

            drain_artifact_indexing(session_store)
            assert session_store.artifact_index_status(session["id"])["indexed"] == 1

    asyncio.run(flow())


@pytest.mark.parametrize("count", [1, 200, 201])
def test_batch_split_never_silently_truncates(count: int) -> None:
    with TemporaryDirectory() as root:
        store = make_session_store(root)
        session = store.create_session(
            {"taskGoal": "produce", "workspacePath": "/ws", "ownerUserId": "alice"}
        )
        items = [
            {
                "id": f"art-{i}",
                "kind": "workspace_file",
                "title": f"{i}.pdf",
                "path": f"/ws/{i}.pdf",
                "createdAt": "2026-11-17T00:00:00.000Z",
                "agentRunId": "run-1",
                "bytes": 1,
                "contentType": "application/pdf",
                "workspaceRelativePath": f"{i}.pdf",
                "contentBase64": base64.b64encode(b"x").decode("ascii"),
            }
            for i in range(count)
        ]
        store.enqueue_workspace_artifacts(session["id"], "run-1", None, items)
        status = store.artifact_index_status(session["id"])
        expected_batches = (count + ARTIFACT_INDEX_BATCH_LIMIT - 1) // ARTIFACT_INDEX_BATCH_LIMIT
        assert status["pending"] == expected_batches
        assert status["overflow"] == max(0, count - ARTIFACT_INDEX_BATCH_LIMIT)


ARTIFACT_ID = "22222222-2222-4222-8222-222222222222"


def _artifact_item(artifact_id: str, content: bytes) -> dict[str, Any]:
    return {
        "id": artifact_id,
        "kind": "workspace_file",
        "title": "a.pdf",
        "path": "/ws/a.pdf",
        "createdAt": "2026-11-17T00:00:00.000Z",
        "agentRunId": "run-1",
        "bytes": len(content),
        "contentType": "application/pdf",
        "workspaceRelativePath": "a.pdf",
        "contentBase64": base64.b64encode(content).decode("ascii"),
    }


def _expire_lease(store: Any, batch_id: str) -> None:
    """Push a batch's lease far into the past so the next claim re-claims it."""
    with store_transaction(store.engine) as conn:
        conn.execute(
            update(store.artifact_index_batches)
            .where(store.artifact_index_batches.c.id == batch_id)
            .values(claimed_at=datetime(2000, 1, 1, tzinfo=UTC))
        )


def test_overlapping_reclaims_cannot_delete_committed_snapshot_or_duplicate_events(
    tmp_path,
) -> None:
    """The deterministic data-loss regression.

    Two workers claim the same batch (the first lease expired mid-upload), both
    read the thread's already-indexed paths as empty, then both index the same
    pre-minted artifact id. The loser's insert must be a no-op that neither
    duplicates the event nor deletes the winner's committed snapshot blob.
    """
    blobs = MemoryBlobStore()
    store = DatabaseSessionStore(
        f"sqlite:///{tmp_path}/relay.db", create_schema=True, blob_store=blobs
    )
    session = store.create_session(
        {"taskGoal": "produce", "workspacePath": "/ws", "ownerUserId": "alice"}
    )
    content = b"committed snapshot bytes"
    store.enqueue_workspace_artifacts(
        session["id"], "run-1", None, [_artifact_item(ARTIFACT_ID, content)]
    )

    first = store.claim_artifact_index_batches(limit=1, lease_seconds=300.0)
    assert len(first) == 1
    _expire_lease(store, first[0]["id"])
    second = store.claim_artifact_index_batches(limit=1, lease_seconds=300.0)
    assert len(second) == 1
    assert first[0]["id"] == second[0]["id"]
    assert first[0]["leaseToken"] != second[0]["leaseToken"]

    # The stale-reader interleaving: both workers read no indexed paths, then
    # both insert the same pre-minted id directly (the worker's per-path dedupe
    # is the read that was stale).
    for batch in (first[0], second[0]):
        item = batch["items"][0]
        artifact = {key: value for key, value in item.items() if key != "contentBase64"}
        decoded = base64.b64decode(item["contentBase64"])
        store.index_workspace_artifact(session["id"], artifact, decoded)

    created = [
        event
        for event in store.get_session(session["id"])["events"]
        if event["type"] == "artifact.created"
    ]
    assert len(store.get_session(session["id"])["artifacts"]) == 1
    assert len(created) == 1
    # The committed snapshot must survive: the losing worker never deleted it.
    assert store.read_artifact_content(session["id"], ARTIFACT_ID) == content
    assert blobs.blobs


def test_stale_claim_cannot_mutate_newer_claim_status(tmp_path) -> None:
    store = make_session_store(tmp_path)
    session = store.create_session(
        {"taskGoal": "produce", "workspacePath": "/ws", "ownerUserId": "alice"}
    )
    store.enqueue_workspace_artifacts(
        session["id"], "run-1", None, [_artifact_item(ARTIFACT_ID, b"x")]
    )

    first = store.claim_artifact_index_batches(limit=1, lease_seconds=300.0)[0]
    _expire_lease(store, first["id"])
    second = store.claim_artifact_index_batches(limit=1, lease_seconds=300.0)[0]
    assert first["id"] == second["id"]
    assert first["leaseToken"] != second["leaseToken"]

    # A stale worker (the first claim) cannot fail or requeue the batch the
    # newer claim now owns; its fenced update matches zero rows.
    assert (
        store.fail_artifact_index_batch(
            first["id"], "stale", attempts=5, lease_token=first["leaseToken"]
        )
        is False
    )
    status = store.artifact_index_status(session["id"])
    assert status["failed"] == 0
    assert status["pending"] == 1  # still indexing under the newer claim

    # The current owner completes it normally.
    assert (
        store.complete_artifact_index_batch(
            second["id"], lease_token=second["leaseToken"]
        )
        is True
    )
    assert store.artifact_index_status(session["id"])["indexed"] == 1


def test_completion_transaction_count_is_bounded_regardless_of_file_count() -> None:
    async def flow() -> None:
        counts: dict[int, int] = {}
        for n in (1, 150, 200, 201):
            with TemporaryDirectory() as root:
                session_store = make_session_store(root)
                registry = DaemonNodeRegistry(session_store, make_daemon_store(root))
                _register(registry, capabilities=["generated-files", "workspace-scope", "thread-workspaces"])
                await ServerDaemonNodeBackend(registry).run(
                    "sbx_alice", {"taskGoal": "produce", "assignments": [{"agent": "codex"}]}
                )
                [command] = registry.take_commands("sbx_alice", "node_token")

                began: list[int] = []

                def on_begin(_conn: Any, counts: list[int] = began) -> None:
                    counts.append(1)

                event.listen(session_store.engine, "begin", on_begin)
                try:
                    registry.handle_event(
                        "sbx_alice",
                        {
                            "type": "run.completed",
                            "commandId": command["id"],
                            "sessionId": command["sessionId"],
                            "runId": command["runId"],
                            "agent": "codex",
                            "exitCode": 0,
                            "agentLog": "done",
                            "generatedFiles": [_pdf(f"r/{i}.pdf") for i in range(n)],
                        },
                        "node_token",
                    )
                finally:
                    event.remove(session_store.engine, "begin", on_begin)
                counts[n] = len(began)
                assert session_store.artifact_index_status(command["sessionId"])["pending"] >= 1

        # One completion costs the same number of SQL transactions whatever the
        # file count: indexing is enqueued once, never once per file.
        assert counts[1] == counts[150] == counts[200] == counts[201]
        assert counts[1] < 200

    asyncio.run(flow())


def test_durable_completion_rollback_leaves_no_receipt_or_orphan_batch(
    tmp_path, monkeypatch
) -> None:
    """The durable receipt and the pending batch commit (or roll back) together."""

    async def flow() -> None:
        with TemporaryDirectory() as root:
            session_store = make_session_store(root)
            daemon_store = make_daemon_store(root)
            registry = DaemonNodeRegistry(session_store, daemon_store)
            _register(registry, capabilities=["generated-files", "workspace-scope", "thread-workspaces"])
            await ServerDaemonNodeBackend(registry).run(
                "sbx_alice", {"taskGoal": "produce", "assignments": [{"agent": "codex"}]}
            )
            [command] = registry.take_commands("sbx_alice", "node_token")

            event_payload = {
                "type": "run.completed",
                "commandId": command["id"],
                "sessionId": command["sessionId"],
                "runId": command["runId"],
                "agent": "codex",
                "leaseId": command.get("leaseId"),
                "exitCode": 0,
                "agentLog": "done",
                "generatedFiles": [_pdf("reports/a.pdf")],
            }
            report_id, digest = "a" * 64, "b" * 64

            original = daemon_store.mark_command_completed

            def fail(node_id: str, event: dict[str, Any]) -> Any:
                original(node_id, event)
                raise RuntimeError("injected terminal failure")

            monkeypatch.setattr(daemon_store, "mark_command_completed", fail)
            with pytest.raises(RuntimeError, match="injected"):
                registry.handle_durable_report(
                    "sbx_alice", event_payload, "node_token", report_id, digest
                )
            monkeypatch.setattr(daemon_store, "mark_command_completed", original)

            # The rollback discarded both the accepted receipt and the queued
            # indexing batch, so a retry re-enqueues rather than duplicating.
            assert not daemon_store.report_was_accepted(
                "sbx_alice", command["id"], report_id, digest
            )
            assert session_store.pending_artifact_index_batch_count() == 0
            assert session_store.artifact_index_status(command["sessionId"])["pending"] == 0

    asyncio.run(flow())


def test_enqueue_is_atomic_with_the_completion_transaction(tmp_path) -> None:
    store = make_session_store(tmp_path)
    session = store.create_session(
        {"taskGoal": "produce", "workspacePath": "/ws", "ownerUserId": "alice"}
    )
    try:
        with store_transaction(store.engine):
            store.enqueue_workspace_artifacts(
                session["id"], "run-1", None, [_artifact_item(ARTIFACT_ID, b"bytes")]
            )
            raise RuntimeError("abort completion transaction")
    except RuntimeError:
        pass
    assert store.pending_artifact_index_batch_count() == 0
    assert store.artifact_index_status(session["id"])["pending"] == 0


@pytest.mark.parametrize("wire", ["legacy", "events", "reports"])
def test_http_completion_transactions_do_not_grow_with_file_count(tmp_path, wire):
    """Exercise the actual HTTP parser, receipt and registry, not a mocked handler."""
    from dataclasses import replace
    from hashlib import sha256
    import json
    from time import perf_counter
    from fastapi.testclient import TestClient
    from relay.app import create_app

    counts = []
    for n in (1, 150, 201):
        root = tmp_path / str(n)
        store = make_session_store(root)
        registry = DaemonNodeRegistry(store, make_daemon_store(root))
        _register(registry, capabilities=["generated-files", "workspace-scope", "thread-workspaces"])
        asyncio.run(ServerDaemonNodeBackend(registry).run(
            "sbx_alice", {"taskGoal": "produce", "assignments": [{"agent": "codex"}]}
        ))
        [command] = registry.take_commands("sbx_alice", "node_token")
        app = create_app(str(root / "app"))
        app.state.context = replace(app.state.context, registry=registry)
        client = TestClient(app)
        payload = {"type": "run.completed", "commandId": command["id"],
                   "sessionId": command["sessionId"], "runId": command["runId"],
                   "agent": "codex", "leaseId": command.get("leaseId"),
                   "exitCode": 0, "agentLog": "done",
                   "generatedFiles": [_pdf(f"reports/{i}.pdf") for i in range(n)]}
        raw = json.dumps(payload)
        report_id, digest = "a" * 64, sha256(raw.encode()).hexdigest()
        headers = {"Authorization": "Bearer node_token", "Content-Type": "application/json"}
        path = f"/api/v1/daemon-nodes/sbx_alice/{'reports' if wire == 'reports' else 'events'}"
        if wire == "reports":
            body = json.dumps({"reports": [{"id": report_id, "digest": digest, "body": raw}]})
        else:
            body = raw
            if wire == "events":
                headers.update({"X-Relay-Report-Id": report_id, "X-Relay-Report-Digest": digest})

        begins = []
        def begin(conn, counts=begins):
            counts.append(1)
        event.listen(store.engine, "begin", begin)
        started = perf_counter()
        try:
            response = client.post(path, content=body, headers=headers)
        finally:
            event.remove(store.engine, "begin", begin)
        assert response.status_code == 200, response.text
        if wire == "reports":
            assert response.json()["receipts"][0]["status"] == 200
        assert perf_counter() - started < 5
        counts.append(len(begins))
        assert store.artifact_index_status(command["sessionId"])["pending"] == (2 if n > 200 else 1)
        assert store.get_session(command["sessionId"])["artifacts"] == []
        if wire != "legacy":
            def unexpected(*args, **kwargs):
                pytest.fail("Accepted receipt replay entered live registry processing")
            registry.handle_durable_report = unexpected
            replay = client.post(path, content=body, headers=headers)
            assert replay.status_code == 200
            if wire == "reports":
                assert replay.json()["receipts"][0]["status"] == 200
    assert counts[0] == counts[1] == counts[2], counts
