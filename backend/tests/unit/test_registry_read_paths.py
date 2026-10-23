"""The registry's hot paths read headers and indexed rows, never a replayed thread.

A thread's event log can hold thousands of streamed output rows; the daemon
poll, the reaper pass, and the terminal-event handler must not replay it for
decisions that only need snapshot fields.
"""

from __future__ import annotations

import asyncio
import base64
import threading
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from relay.daemon_registry.node_backend import ServerDaemonNodeBackend
from relay.daemon_registry.registry import DaemonNodeRegistry
from store_fixtures import make_daemon_store, make_session_store


def _register(registry: DaemonNodeRegistry, workspace: str) -> None:
    registry.register(
        {
            "sandboxId": "sbx_alice",
            "userId": "alice",
            "token": "node_token",
            "workspacePath": workspace,
            "protocolVersion": 1,
            "supportedAgents": ["codex"],
            "capabilities": ["thread-workspaces", "generated-files"],
            "status": "ready",
        },
        "ui_token",
    )


def _count_calls(monkeypatch: Any, store: Any, name: str) -> list[str]:
    calls: list[str] = []
    original = getattr(store, name)

    def counted(*args: Any, **kwargs: Any) -> Any:
        calls.append(name)
        return original(*args, **kwargs)

    monkeypatch.setattr(store, name, counted)
    return calls


async def _started_run(root: str) -> tuple[DaemonNodeRegistry, Any, dict[str, Any], dict[str, Any]]:
    workspace = Path(root) / "workspace"
    workspace.mkdir()
    session_store = make_session_store(root)
    registry = DaemonNodeRegistry(session_store, make_daemon_store(root))
    _register(registry, str(workspace))
    session = await ServerDaemonNodeBackend(registry).run(
        "sbx_alice", {"taskGoal": "produce a file", "assignments": [{"agent": "codex"}]}
    )
    [command] = registry.take_commands("sbx_alice", "node_token")
    return registry, session_store, session, command


def _completed(command: dict[str, Any], files: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "type": "run.completed",
        "commandId": command["id"],
        "sessionId": command["sessionId"],
        "runId": command["runId"],
        "agent": "codex",
        "exitCode": 0,
        "agentLog": "done",
        "generatedFiles": files,
    }


def _file(path: str, content: bytes) -> dict[str, Any]:
    return {"relativePath": path, "contentBase64": base64.b64encode(content).decode("ascii")}


def test_reaper_recovery_pass_reads_session_headers_only(monkeypatch: Any) -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            registry, session_store, _session, _command = await _started_run(root)
            full_reads = _count_calls(monkeypatch, session_store, "get_session")
            header_reads = _count_calls(monkeypatch, session_store, "get_session_header")

            registry.reap_stale_runs(force=True)

            assert full_reads == []
            assert header_reads, "recovery must still look at the thread"

    asyncio.run(run_flow())


def test_workspace_blocker_check_reads_headers_only(monkeypatch: Any) -> None:
    with TemporaryDirectory() as root:
        session_store = make_session_store(root)
        registry = DaemonNodeRegistry(session_store, make_daemon_store(root))
        shared = {"workspacePath": "/w", "ownerUserId": "alice", "computerId": "c1",
                  "workspaceLayout": "task", "workspaceSubpath": "tasks/t1", "taskGoal": "a"}
        first = session_store.create_session(shared)
        second = session_store.create_session({**shared, "taskGoal": "b"})
        other = session_store.create_session({**shared, "ownerUserId": "bob"})
        full_reads = _count_calls(monkeypatch, session_store, "get_session")

        assert registry._blocker_shares_workspace(first["id"], second["id"]) is True
        assert registry._blocker_shares_workspace(other["id"], second["id"]) is False
        assert registry._blocker_shares_workspace("missing", second["id"]) is False
        assert full_reads == []


def test_streamed_output_append_never_replays_the_thread(monkeypatch: Any) -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            registry, session_store, session, command = await _started_run(root)
            full_reads = _count_calls(monkeypatch, session_store, "get_session")
            for sequence in range(3):
                registry.handle_event(
                    "sbx_alice",
                    {
                        "type": "run.output", "commandId": command["id"],
                        "sessionId": command["sessionId"], "runId": command["runId"],
                        "agent": "codex", "stream": "stdout", "text": str(sequence),
                        "sequence": sequence,
                    },
                    "node_token",
                )
            assert full_reads == []
            texts = [e["text"] for e in session_store.get_session(session["id"])["events"]
                     if e.get("type") == "agent.output"]
            assert texts == ["0", "1", "2"]

    asyncio.run(run_flow())


def test_completion_indexes_generated_files_outside_the_global_lock(monkeypatch: Any) -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            registry, session_store, session, command = await _started_run(root)
            global_lock_free: list[bool] = []
            original_index = session_store.index_workspace_artifact

            def probe_lock() -> None:
                # Another thread can take the global lock only if the
                # completion handler has let go of it.
                acquired = registry.dispatch_lock.acquire(blocking=False)
                global_lock_free.append(acquired)
                if acquired:
                    registry.dispatch_lock.release()

            def index_with_probe(*args: Any, **kwargs: Any) -> Any:
                prober = threading.Thread(target=probe_lock)
                prober.start()
                prober.join()
                return original_index(*args, **kwargs)

            monkeypatch.setattr(session_store, "index_workspace_artifact", index_with_probe)
            event = _completed(command, [_file("a.md", b"# a"), _file("b.md", b"# b")])

            registry.handle_event("sbx_alice", event, "node_token")

            assert global_lock_free == [True, True]
            updated = session_store.get_session(session["id"])
            assert updated["status"] == "completed"
            assert sorted(a["workspaceRelativePath"] for a in updated["artifacts"]
                          if a["kind"] == "workspace_file") == ["a.md", "b.md"]

            # A replayed terminal event settles without indexing a second copy.
            registry.handle_event("sbx_alice", {**event, "replayed": True}, "node_token")
            again = session_store.get_session(session["id"])
            assert len([a for a in again["artifacts"] if a["kind"] == "workspace_file"]) == 2

    asyncio.run(run_flow())


def test_completion_retry_after_indexing_failure_does_not_duplicate_artifacts(monkeypatch: Any) -> None:
    async def run_flow() -> None:
        with TemporaryDirectory() as root:
            registry, session_store, session, command = await _started_run(root)
            original_index = session_store.index_workspace_artifact
            failures = {"left": 1}

            def flaky_index(*args: Any, **kwargs: Any) -> Any:
                result = original_index(*args, **kwargs)
                if failures["left"]:
                    failures["left"] -= 1
                    raise RuntimeError("blob store hiccup")
                return result

            monkeypatch.setattr(session_store, "index_workspace_artifact", flaky_index)
            event = _completed(command, [_file("a.md", b"# a"), _file("b.md", b"# b")])
            try:
                registry.handle_event("sbx_alice", event, "node_token")
            except RuntimeError:
                pass
            monkeypatch.setattr(session_store, "index_workspace_artifact", original_index)

            registry.handle_event("sbx_alice", {**event, "replayed": True}, "node_token")
            registry.reap_stale_runs(force=True)

            updated = session_store.get_session(session["id"])
            paths = sorted(a["workspaceRelativePath"] for a in updated["artifacts"]
                           if a["kind"] == "workspace_file")
            assert paths == ["a.md", "b.md"]

    asyncio.run(run_flow())
