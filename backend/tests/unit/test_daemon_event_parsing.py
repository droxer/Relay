"""Characterization tests pinning `daemon_node_event` output and errors.

Expected values were captured from the parser before its table-driven
restructuring; every case must keep producing the identical dict (including
key order) or the identical ValueError message.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest

from relay.api.daemon_events import daemon_node_event


def run(event_type: str, **extra: Any) -> dict[str, Any]:
    return {
        "type": event_type,
        "commandId": " cmd-1 ",
        "sessionId": "sess-1",
        "runId": "run-1",
        "agent": "claude",
        "leaseId": "lease-1",
        **extra,
    }


def ws(event_type: str, **extra: Any) -> dict[str, Any]:
    return {
        "type": event_type,
        "commandId": "cmd-ws",
        "leaseId": "lease-ws",
        "agentId": " agent-1 ",
        "path": " docs/a.md ",
        **extra,
    }


COLLAB = {
    "id": " c-1 ",
    "tool": "spawnAgent",
    "status": "completed",
    "senderThreadId": "t-0",
    "receiverThreadIds": ["t-1", "t-2"],
    "prompt": "go",
    "model": 5,
    "reasoningEffort": "high",
    "agentsStates": {
        "t-1": {"status": "running", "message": "busy"},
        "t-2": {"status": "completed"},
    },
}


def collab(**overrides: Any) -> dict[str, Any]:
    return {**COLLAB, **overrides}


def entry(text: str = "hi", stream: str = "stdout", sequence: Any = 1) -> dict[str, Any]:
    return {"stream": stream, "text": text, "sequence": sequence}


PERMISSION = {"id": "perm_0123abcd", "toolName": " Bash ", "input": "ls", "toolUseId": "tu-1"}

CASES: list[tuple[str, dict[str, Any]]] = [
    # workspace responses
    ("ws_listing", ws("workspace.listing", exists=True, entries=[{"name": "a"}])),
    ("ws_listing_bare", {"type": "workspace.listing", "commandId": "c", "exists": False, "entries": []}),
    ("ws_listing_bad_exists", ws("workspace.listing", exists="yes", entries=[])),
    ("ws_listing_bad_entries", ws("workspace.listing", exists=True, entries={})),
    ("ws_file", ws("workspace.file", bytes=12.7, isBinary=False, truncated=True, contentBase64="aGk=")),
    ("ws_file_no_content", ws("workspace.file", bytes=3, isBinary=True, truncated=False, contentBase64=7)),
    ("ws_file_bad_bytes", ws("workspace.file", bytes="3", isBinary=True, truncated=False)),
    ("ws_file_bad_truncated", ws("workspace.file", bytes=3, isBinary=True, truncated=None)),
    ("ws_error", ws("workspace.error", code=" not-found ", message=" gone ")),
    ("ws_error_link_code", ws("workspace.error", code="protected")),
    ("ws_error_bad_code", ws("workspace.error", code="boom", message="x")),
    ("ws_deleted", ws("workspace.deleted")),
    ("ws_linked", ws("workspace.linked", hostPath=" /home/u/p ")),
    ("ws_linked_missing_host", ws("workspace.linked", hostPath="  ")),
    ("ws_missing_command", {"type": "workspace.file", "commandId": "   ", "path": "a"}),
    # run envelope
    ("missing_type", {"commandId": "c", "sessionId": "s", "runId": "r", "agent": "claude"}),
    ("unknown_type", run("run.mystery")),
    ("unknown_type_bad_envelope", {"type": "run.mystery"}),
    ("bad_agent", run("run.output", agent="gpt")),
    ("missing_session", run("run.completed", sessionId="")),
    ("missing_run", run("run.completed", runId=None)),
    ("missing_command", run("run.completed", commandId=" ")),
    ("missing_agent", {k: v for k, v in run("run.started").items() if k != "agent"}),
    # run.executing
    ("executing_bare", run("run.executing", leaseId="")),
    ("executing_empty_skips", run("run.executing", skillsSkipped=[])),
    (
        "executing_skips",
        run(
            "run.executing",
            skillsSkipped=[
                {"skillId": " sk-1 ", "slug": " team/sk ", "reason": " missing "},
                {"skillId": "sk-2", "reason": "disabled", "extra": 1},
            ],
        ),
    ),
    ("executing_skips_not_list", run("run.executing", skillsSkipped="nope")),
    ("executing_skips_null", run("run.executing", skillsSkipped=None)),
    ("executing_skip_not_dict", run("run.executing", skillsSkipped=["sk"])),
    ("executing_skip_blank_id", run("run.executing", skillsSkipped=[{"skillId": " ", "reason": "r"}])),
    ("executing_skip_null_slug", run("run.executing", skillsSkipped=[{"skillId": "a", "slug": None, "reason": "r"}])),
    ("executing_skip_long_reason", run("run.executing", skillsSkipped=[{"skillId": "a", "reason": "r" * 201}])),
    ("executing_skip_missing_reason", run("run.executing", skillsSkipped=[{"skillId": "a"}])),
    # run.exit_unconfirmed
    ("exit_unconfirmed", run("run.exit_unconfirmed", replayed=True)),
    # run.workspace
    ("workspace_wait", run("run.workspace", waiting=True, blockingSessionId="sess-0")),
    ("workspace_wait_no_blocker", run("run.workspace", waiting=False, blockingSessionId=None)),
    ("workspace_wait_empty_blocker", run("run.workspace", waiting=False, blockingSessionId="")),
    ("workspace_wait_bad_waiting", run("run.workspace", waiting="true")),
    ("workspace_wait_long_blocker", run("run.workspace", waiting=True, blockingSessionId="b" * 201)),
    ("workspace_wait_int_blocker", run("run.workspace", waiting=True, blockingSessionId=4)),
    # run.permission_requested
    ("permission", run("run.permission_requested", request=PERMISSION)),
    ("permission_not_dict", run("run.permission_requested", request="x")),
    ("permission_bad_tool", run("run.permission_requested", request={**PERMISSION, "toolName": " "})),
    # run.output
    ("output", run("run.output", stream="stderr", sequence=4.9, text="  hi  ")),
    ("output_replayed", run("run.output", stream="stdout", sequence=1, text="", replayed=True)),
    ("output_replayed_truthy", run("run.output", stream="stdout", sequence=1, text="a", replayed=1, leaseId=None)),
    ("output_bad_stream", run("run.output", stream="log", sequence=1, text="a")),
    ("output_bad_sequence", run("run.output", stream="stdout", sequence="1", text="a")),
    ("output_bad_text", run("run.output", stream="stdout", sequence=1, text=None)),
    # run.output.batch
    ("batch", run("run.output.batch", entries=[entry(), entry("err", "stderr", 2.5)], extra=1)),
    ("batch_replayed", run("run.output.batch", entries=[entry()], replayed=True, leaseId="")),
    ("batch_empty", run("run.output.batch", entries=[])),
    ("batch_not_list", run("run.output.batch", entries="x")),
    ("batch_too_many", run("run.output.batch", entries=[entry()] * 1025)),
    ("batch_max_count", run("run.output.batch", entries=[entry("", sequence=i) for i in range(1024)])),
    ("batch_bad_entry", run("run.output.batch", entries=[entry(), "x"])),
    ("batch_bad_entry_stream", run("run.output.batch", entries=[entry(stream="x")])),
    ("batch_too_large", run("run.output.batch", entries=[entry("a" * (512 * 1024)), entry("b")])),
    ("batch_max_size", run("run.output.batch", entries=[entry("a" * (512 * 1024))])),
    ("batch_large_then_bad", run("run.output.batch", entries=[entry("a" * (512 * 1024 + 1)), "x"])),
    # run.collaboration
    ("collab", run("run.collaboration", sequence=7.2, collaboration=COLLAB, replayed=True)),
    (
        "collab_empty_states",
        run("run.collaboration", sequence=0, collaboration=collab(agentsStates={}, receiverThreadIds=[], prompt=None)),
    ),
    ("collab_not_dict", run("run.collaboration", sequence=1, collaboration=[])),
    ("collab_bad_sequence", run("run.collaboration", sequence=None, collaboration=COLLAB)),
    ("collab_bad_tool", run("run.collaboration", sequence=1, collaboration=collab(tool="x"))),
    ("collab_bad_status", run("run.collaboration", sequence=1, collaboration=collab(status="x"))),
    ("collab_blank_id", run("run.collaboration", sequence=1, collaboration=collab(id=" "))),
    ("collab_blank_sender", run("run.collaboration", sequence=1, collaboration=collab(senderThreadId=None))),
    ("collab_receivers_not_list", run("run.collaboration", sequence=1, collaboration=collab(receiverThreadIds="t"))),
    (
        "collab_receivers_too_many",
        run("run.collaboration", sequence=1, collaboration=collab(receiverThreadIds=["t"] * 65)),
    ),
    ("collab_receiver_blank", run("run.collaboration", sequence=1, collaboration=collab(receiverThreadIds=[""]))),
    ("collab_states_not_dict", run("run.collaboration", sequence=1, collaboration=collab(agentsStates=[]))),
    (
        "collab_states_too_many",
        run(
            "run.collaboration",
            sequence=1,
            collaboration=collab(agentsStates={f"t{i}": {"status": "running"} for i in range(65)}),
        ),
    ),
    (
        "collab_state_blank_key",
        run("run.collaboration", sequence=1, collaboration=collab(agentsStates={"": {"status": "running"}})),
    ),
    (
        "collab_state_not_dict",
        run("run.collaboration", sequence=1, collaboration=collab(agentsStates={"t": "running"})),
    ),
    (
        "collab_state_bad_status",
        run("run.collaboration", sequence=1, collaboration=collab(agentsStates={"t": {"status": "x"}})),
    ),
    (
        "collab_state_bad_message",
        run(
            "run.collaboration",
            sequence=1,
            collaboration=collab(agentsStates={"t": {"status": "running", "message": 3}}),
        ),
    ),
    # run.completed
    (
        "completed_full",
        run(
            "run.completed",
            exitCode=0.0,
            agentLog="  log  ",
            tokenUsage={"input": 10, "output": 5},
            generatedFiles=[{"path": "a.md"}],
            roundResult={"status": "done"},
            outputTruncated=True,
            runtimeSessionId="abcdefgh-123",
            projectSetup={"goal": "g"},
            replayed=True,
        ),
    ),
    (
        "completed_minimal",
        run(
            "run.completed",
            exitCode=2,
            agentLog=5,
            generatedFiles={},
            roundResult=[],
            outputTruncated=1,
            runtimeSessionId="short",
            projectSetup="x",
            leaseId=None,
        ),
    ),
    ("completed_bad_usage", run("run.completed", exitCode=1, tokenUsage="lots")),
    ("completed_bad_runtime_session", run("run.completed", exitCode=1, runtimeSessionId="has space id")),
    ("completed_missing_exit", run("run.completed")),
    ("completed_string_exit", run("run.completed", exitCode="0", tokenUsage="bad")),
    # run.failed
    (
        "failed_full",
        run(
            "run.failed",
            error="  boom  ",
            runtimeSessionId="abcdefgh",
            agentLog="  log  ",
            exitCode=3.9,
            tokenUsage={"input": 1, "output": 1},
            generatedFiles=[],
        ),
    ),
    ("failed_minimal", run("run.failed", error="  ", agentLog=None, exitCode="3", generatedFiles="x")),
    ("failed_bad_usage", run("run.failed", tokenUsage=[1])),
    # run.cancelled
    (
        "cancelled_full",
        run(
            "run.cancelled",
            reason=" stop ",
            runtimeSessionId="abcdefgh",
            agentLog="",
            tokenUsage={"input": 2, "output": 3},
            exitCode=1,
            generatedFiles=[],
        ),
    ),
    ("cancelled_minimal", run("run.cancelled")),
]


EXPECTED: dict[str, tuple[str, Any]] = {
    "ws_listing": (
        "ok",
        {
            "type": "workspace.listing",
            "commandId": "cmd-ws",
            "leaseId": "lease-ws",
            "agentId": "agent-1",
            "path": "docs/a.md",
            "exists": True,
            "entries": [{"name": "a"}],
        },
    ),
    "ws_listing_bare": (
        "ok",
        {"type": "workspace.listing", "commandId": "c", "path": "", "exists": False, "entries": []},
    ),
    "ws_listing_bad_exists": ("error", "invalid daemon workspace.listing event."),
    "ws_listing_bad_entries": ("error", "invalid daemon workspace.listing event."),
    "ws_file": (
        "ok",
        {
            "type": "workspace.file",
            "commandId": "cmd-ws",
            "leaseId": "lease-ws",
            "agentId": "agent-1",
            "path": "docs/a.md",
            "bytes": 12,
            "isBinary": False,
            "truncated": True,
            "contentBase64": "aGk=",
        },
    ),
    "ws_file_no_content": (
        "ok",
        {
            "type": "workspace.file",
            "commandId": "cmd-ws",
            "leaseId": "lease-ws",
            "agentId": "agent-1",
            "path": "docs/a.md",
            "bytes": 3,
            "isBinary": True,
            "truncated": False,
        },
    ),
    "ws_file_bad_bytes": ("error", "invalid daemon workspace.file event."),
    "ws_file_bad_truncated": ("error", "invalid daemon workspace.file event."),
    "ws_error": (
        "ok",
        {
            "type": "workspace.error",
            "commandId": "cmd-ws",
            "leaseId": "lease-ws",
            "agentId": "agent-1",
            "path": "docs/a.md",
            "code": "not-found",
            "message": "gone",
        },
    ),
    "ws_error_link_code": (
        "ok",
        {
            "type": "workspace.error",
            "commandId": "cmd-ws",
            "leaseId": "lease-ws",
            "agentId": "agent-1",
            "path": "docs/a.md",
            "code": "protected",
            "message": "",
        },
    ),
    "ws_error_bad_code": ("error", "invalid daemon workspace.error event."),
    "ws_deleted": (
        "ok",
        {
            "type": "workspace.deleted",
            "commandId": "cmd-ws",
            "leaseId": "lease-ws",
            "agentId": "agent-1",
            "path": "docs/a.md",
        },
    ),
    "ws_linked": (
        "ok",
        {
            "type": "workspace.linked",
            "commandId": "cmd-ws",
            "leaseId": "lease-ws",
            "agentId": "agent-1",
            "path": "docs/a.md",
            "hostPath": "/home/u/p",
        },
    ),
    "ws_linked_missing_host": ("error", "invalid daemon workspace.linked event."),
    "ws_missing_command": ("error", "workspace event requires commandId."),
    "missing_type": ("error", "unknown daemon node event type ."),
    "unknown_type": ("error", "unknown daemon node event type run.mystery."),
    "unknown_type_bad_envelope": ("error", "daemon node event requires commandId, sessionId, runId, and agent."),
    "bad_agent": ("error", "daemon node event requires commandId, sessionId, runId, and agent."),
    "missing_session": ("error", "daemon node event requires commandId, sessionId, runId, and agent."),
    "missing_run": ("error", "daemon node event requires commandId, sessionId, runId, and agent."),
    "missing_command": ("error", "daemon node event requires commandId, sessionId, runId, and agent."),
    "missing_agent": ("error", "daemon node event requires commandId, sessionId, runId, and agent."),
    "executing_bare": (
        "ok",
        {"type": "run.executing", "commandId": "cmd-1", "sessionId": "sess-1", "runId": "run-1", "agent": "claude"},
    ),
    "executing_empty_skips": (
        "ok",
        {
            "type": "run.executing",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
        },
    ),
    "executing_skips": (
        "ok",
        {
            "type": "run.executing",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "skillsSkipped": [
                {"skillId": "sk-1", "slug": "team/sk", "reason": "missing"},
                {"skillId": "sk-2", "reason": "disabled"},
            ],
        },
    ),
    "executing_skips_not_list": ("error", "invalid run.executing skillsSkipped."),
    "executing_skips_null": ("error", "invalid run.executing skillsSkipped."),
    "executing_skip_not_dict": ("error", "invalid run.executing skillsSkipped entry."),
    "executing_skip_blank_id": ("error", "invalid run.executing skillsSkipped entry."),
    "executing_skip_null_slug": ("error", "invalid run.executing skillsSkipped entry."),
    "executing_skip_long_reason": ("error", "invalid run.executing skillsSkipped entry."),
    "executing_skip_missing_reason": ("error", "invalid run.executing skillsSkipped entry."),
    "exit_unconfirmed": (
        "ok",
        {
            "type": "run.exit_unconfirmed",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
        },
    ),
    "workspace_wait": (
        "ok",
        {
            "type": "run.workspace",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "waiting": True,
            "blockingSessionId": "sess-0",
        },
    ),
    "workspace_wait_no_blocker": (
        "ok",
        {
            "type": "run.workspace",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "waiting": False,
        },
    ),
    "workspace_wait_empty_blocker": (
        "ok",
        {
            "type": "run.workspace",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "waiting": False,
        },
    ),
    "workspace_wait_bad_waiting": ("error", "invalid daemon workspace wait state."),
    "workspace_wait_long_blocker": ("error", "invalid blocking session id."),
    "workspace_wait_int_blocker": ("error", "invalid blocking session id."),
    "permission": (
        "ok",
        {
            "type": "run.permission_requested",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "request": {"id": "perm_0123abcd", "toolName": "Bash", "input": "ls", "toolUseId": "tu-1"},
        },
    ),
    "permission_not_dict": ("error", "invalid run.permission_requested request."),
    "permission_bad_tool": ("error", "invalid permission request toolName."),
    "output": (
        "ok",
        {
            "type": "run.output",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "stream": "stderr",
            "text": "  hi  ",
            "sequence": 4,
        },
    ),
    "output_replayed": (
        "ok",
        {
            "type": "run.output",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "replayed": True,
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "stream": "stdout",
            "text": "",
            "sequence": 1,
        },
    ),
    "output_replayed_truthy": (
        "ok",
        {
            "type": "run.output",
            "commandId": "cmd-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "stream": "stdout",
            "text": "a",
            "sequence": 1,
        },
    ),
    "output_bad_stream": ("error", "invalid daemon node run.output event."),
    "output_bad_sequence": ("error", "invalid daemon node run.output event."),
    "output_bad_text": ("error", "invalid daemon node run.output event."),
    "batch": (
        "ok",
        {
            "type": "run.output.batch",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "entries": [
                {"stream": "stdout", "text": "hi", "sequence": 1},
                {"stream": "stderr", "text": "err", "sequence": 2},
            ],
        },
    ),
    "batch_replayed": (
        "ok",
        {
            "type": "run.output.batch",
            "commandId": "cmd-1",
            "replayed": True,
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "entries": [{"stream": "stdout", "text": "hi", "sequence": 1}],
        },
    ),
    "batch_empty": ("error", "invalid daemon node run.output.batch event."),
    "batch_not_list": ("error", "invalid daemon node run.output.batch event."),
    "batch_too_many": ("error", "invalid daemon node run.output.batch event."),
    "batch_max_count": ("digest", "a70207842096dd1641eb9372aeaa355cfac61263a9b193c1f16e3a9d59592f36"),
    "batch_bad_entry": ("error", "invalid daemon node run.output.batch entry."),
    "batch_bad_entry_stream": ("error", "invalid daemon node run.output.batch entry."),
    "batch_too_large": ("error", "daemon node run.output.batch text is too large."),
    "batch_max_size": ("digest", "5490b9f8eee66d3222b3da9db9ff3dab623fbee9434ba983dbb5838037c1bd85"),
    "batch_large_then_bad": ("error", "daemon node run.output.batch text is too large."),
    "collab": (
        "ok",
        {
            "type": "run.collaboration",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "replayed": True,
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "sequence": 7,
            "collaboration": {
                "id": "c-1",
                "tool": "spawnAgent",
                "status": "completed",
                "senderThreadId": "t-0",
                "receiverThreadIds": ["t-1", "t-2"],
                "prompt": "go",
                "model": None,
                "reasoningEffort": "high",
                "agentsStates": {
                    "t-1": {"status": "running", "message": "busy"},
                    "t-2": {"status": "completed", "message": None},
                },
            },
        },
    ),
    "collab_empty_states": (
        "ok",
        {
            "type": "run.collaboration",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "sequence": 0,
            "collaboration": {
                "id": "c-1",
                "tool": "spawnAgent",
                "status": "completed",
                "senderThreadId": "t-0",
                "receiverThreadIds": [],
                "prompt": None,
                "model": None,
                "reasoningEffort": "high",
                "agentsStates": {},
            },
        },
    ),
    "collab_not_dict": ("error", "invalid daemon node run.collaboration event."),
    "collab_bad_sequence": ("error", "invalid daemon node run.collaboration event."),
    "collab_bad_tool": ("error", "invalid daemon node collaboration payload."),
    "collab_bad_status": ("error", "invalid daemon node collaboration payload."),
    "collab_blank_id": ("error", "invalid daemon node collaboration payload."),
    "collab_blank_sender": ("error", "invalid daemon node collaboration payload."),
    "collab_receivers_not_list": ("error", "invalid daemon node collaboration payload."),
    "collab_receivers_too_many": ("error", "invalid daemon node collaboration payload."),
    "collab_receiver_blank": ("error", "invalid daemon node collaboration payload."),
    "collab_states_not_dict": ("error", "invalid daemon node collaboration payload."),
    "collab_states_too_many": ("error", "invalid daemon node collaboration payload."),
    "collab_state_blank_key": ("error", "invalid daemon node collaboration agent state."),
    "collab_state_not_dict": ("error", "invalid daemon node collaboration agent state."),
    "collab_state_bad_status": ("error", "invalid daemon node collaboration agent status."),
    "collab_state_bad_message": ("error", "invalid daemon node collaboration agent message."),
    "completed_full": (
        "ok",
        {
            "type": "run.completed",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "exitCode": 0,
            "agentLog": "  log  ",
            "tokenUsage": {"input": 10, "output": 5, "cache": 0, "cacheRead": 0, "cacheWrite": 0, "total": 15},
            "generatedFiles": [{"path": "a.md"}],
            "roundResult": {"status": "done"},
            "outputTruncated": True,
            "runtimeSessionId": "abcdefgh-123",
            "projectSetup": {"goal": "g"},
        },
    ),
    "completed_minimal": (
        "ok",
        {
            "type": "run.completed",
            "commandId": "cmd-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "exitCode": 2,
            "agentLog": "",
        },
    ),
    "completed_bad_usage": (
        "ok",
        {
            "type": "run.completed",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "exitCode": 1,
            "agentLog": "",
        },
    ),
    "completed_bad_runtime_session": (
        "ok",
        {
            "type": "run.completed",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "exitCode": 1,
            "agentLog": "",
        },
    ),
    "completed_missing_exit": ("error", "daemon node run.completed exitCode must be a finite number."),
    "completed_string_exit": ("error", "daemon node run.completed exitCode must be a finite number."),
    "failed_full": (
        "ok",
        {
            "type": "run.failed",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "error": "boom",
            "runtimeSessionId": "abcdefgh",
            "agentLog": "  log  ",
            "exitCode": 3,
            "tokenUsage": {"input": 1, "output": 1, "cache": 0, "cacheRead": 0, "cacheWrite": 0, "total": 2},
            "generatedFiles": [],
        },
    ),
    "failed_minimal": (
        "ok",
        {
            "type": "run.failed",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "error": "Daemon node command failed.",
        },
    ),
    "failed_bad_usage": (
        "ok",
        {
            "type": "run.failed",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "error": "Daemon node command failed.",
        },
    ),
    "cancelled_full": (
        "ok",
        {
            "type": "run.cancelled",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "reason": "stop",
            "runtimeSessionId": "abcdefgh",
            "agentLog": "",
            "tokenUsage": {"input": 2, "output": 3, "cache": 0, "cacheRead": 0, "cacheWrite": 0, "total": 5},
        },
    ),
    "cancelled_minimal": (
        "ok",
        {
            "type": "run.cancelled",
            "commandId": "cmd-1",
            "leaseId": "lease-1",
            "sessionId": "sess-1",
            "runId": "run-1",
            "agent": "claude",
            "reason": "Cancelled by human.",
        },
    ),
}


def test_every_case_is_pinned() -> None:
    names = [name for name, _ in CASES]
    assert len(names) == len(set(names))
    assert set(names) == set(EXPECTED)


@pytest.mark.parametrize(("name", "payload"), CASES, ids=[name for name, _ in CASES])
def test_daemon_node_event_matches_characterization(name: str, payload: dict[str, Any]) -> None:
    kind, expected = EXPECTED[name]
    if kind == "error":
        with pytest.raises(ValueError) as caught:
            daemon_node_event(payload)
        assert str(caught.value) == expected
        return
    result = daemon_node_event(payload)
    text = json.dumps(result)
    if kind == "digest":
        assert hashlib.sha256(text.encode()).hexdigest() == expected
        return
    assert result == expected
    # Key order is part of the pinned output.
    assert text == json.dumps(expected)
