import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  apiJson,
  archiveProject,
  archiveSession,
  assignControlPanelDaemonNode,
  assignTask,
  cancelRun,
  deleteTask,
  getWorkspaceBrief,
  listProjectWorkspaceFiles,
  listArtifacts,
  listEmployeeAgents,
  listSessionSummaries,
  listTaskArtifacts,
  listTaskFiles,
  readProjectWorkspaceFile,
  reissueComputerToken,
  RelayApiError,
  renameSession,
  requestThreadRecovery,
  revealComputerToken,
  runLogicalAgents,
  startTask,
  submitThreadMessage,
  updateAgentProfileImage,
  updateComputerDisplayName,
  updateOwnEmployeeAgent,
  updateProject,
  updateUserPreferences,
} from "../src/api.js";

const originalFetch = globalThis.fetch;

describe("apiJson", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renames a computer through the owner-facing daemon-node resource", async () => {
    let requestPath = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestPath = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        node: {
          id: "sbx_alice",
          displayName: "Office Mac",
          status: "ready",
          agents: {},
          createdAt: "2026-07-26T00:00:00Z",
          updatedAt: "2026-07-26T00:00:00Z",
          queuedCommandCount: 0,
          activeRuns: [],
          online: true,
          stale: false,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await updateComputerDisplayName("sbx_alice", "Office Mac");

    assert.equal(requestPath, "/api/v1/daemon-nodes/sbx_alice");
    assert.equal(requestInit?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(requestInit?.body)), { displayName: "Office Mac" });
    assert.equal(result.node.displayName, "Office Mac");
  });

  it("reveals a computer token through the owner-facing token subresource", async () => {
    let requestPath = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestPath = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        nodeToken: "tok_secret",
        daemonEnv: { RELAY_DAEMON_NODE_TOKEN: "tok_secret" },
        daemonCommand: "relay-daemon …",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await revealComputerToken("sbx_alice");

    assert.equal(requestPath, "/api/v1/daemon-nodes/sbx_alice/token");
    assert.equal(requestInit?.method ?? "GET", "GET");
    assert.equal(result.nodeToken, "tok_secret");
  });

  it("reissues a computer token with a POST to the token subresource", async () => {
    let requestPath = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestPath = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        nodeToken: "tok_rotated",
        daemonEnv: { RELAY_DAEMON_NODE_TOKEN: "tok_rotated" },
        daemonCommand: "relay-daemon …",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await reissueComputerToken("sbx_alice");

    assert.equal(requestPath, "/api/v1/daemon-nodes/sbx_alice/token/reissue");
    assert.equal(requestInit?.method, "POST");
    assert.equal(result.nodeToken, "tok_rotated");
  });

  it("persists a changed user preference without resending the other setting", async () => {
    let requestPath = "";
    let requestInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestPath = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        user: {
          id: "usr_alice",
          username: "alice",
          role: "user",
          theme: "dark",
          language: "en",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await updateUserPreferences({ theme: "dark" });

    assert.equal(requestPath, "/api/v1/auth/preferences");
    assert.equal(requestInit?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(requestInit?.body)), { theme: "dark" });
    assert.equal(result.user.theme, "dark");
  });

  it("uses canonical methods and subresources for normalized mutations", async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        path: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    await renameSession("thread 1", "Roadmap");
    await archiveSession("thread 1");
    await cancelRun("thread 1");
    await assignTask("task 1", "agent 1");
    await startTask("task 1");
    await startTask("task 2", { assignments: [{ agentId: "agent selected" }] });
    await assignControlPanelDaemonNode({ nodeId: "node 1", employeeId: "alice" });

    assert.deepEqual(requests, [
      { path: "/api/v1/threads/thread%201", method: "PATCH", body: { title: "Roadmap" } },
      { path: "/api/v1/threads/thread%201", method: "PATCH", body: { archived: true } },
      { path: "/api/v1/threads/thread%201/cancellations", method: "POST", body: { reason: "Cancelled from Relay Web UI." } },
      { path: "/api/v1/tasks/task%201/assignment", method: "PUT", body: { agentId: "agent 1" } },
      { path: "/api/v1/tasks/task%201/runs", method: "POST", body: {} },
      { path: "/api/v1/tasks/task%202/runs", method: "POST", body: { assignments: [{ agentId: "agent selected" }] } },
      { path: "/api/v1/admin/daemon-nodes/node%201/assignment", method: "PUT", body: { employeeId: "alice" } },
    ]);
  });

  it("keeps persisted profile media outside the versioned JSON namespace", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ agent: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await updateAgentProfileImage("agent 1", "data:image/png;base64,AA==");

    assert.equal(requestedUrl, "/profile-images/agents/agent%201");
  });

  it("reports an HTML fallback response instead of attempting to parse it as JSON", async () => {
    globalThis.fetch = (async () => new Response("<!DOCTYPE html><html><body>Relay</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })) as typeof fetch;

    await assert.rejects(
      () => apiJson("/api/v1/agents/agent_1/workspace/files"),
      (error: unknown) => error instanceof RelayApiError
        && error.status === 200
        && error.message.includes("HTML response"),
    );
  });

  it("surfaces JSON detail errors as RelayApiError", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ detail: "Invalid token." }), {
      status: 401,
      statusText: "Unauthorized",
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    await assert.rejects(
      () => apiJson("/api/v1/sandboxes"),
      (error) => error instanceof RelayApiError
        && error.status === 401
        && error.code === "Invalid token."
        && error.message === "Invalid token.",
    );
  });

  it("preserves a stable task deletion error code", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      detail: "task_execution_active",
    }), {
      status: 409,
      statusText: "Conflict",
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    await assert.rejects(
      () => deleteTask("task 1"),
      (error) => error instanceof RelayApiError
        && error.status === 409
        && error.code === "task_execution_active",
    );
  });

  it("surfaces structured JSON detail messages without stringifying the payload", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      detail: {
        code: "workspace_unavailable",
        message: "Agent Hawkeye has no eligible runtime placement (workspace_unavailable).",
      },
    }), {
      status: 409,
      statusText: "Conflict",
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;

    await assert.rejects(
      () => apiJson("/api/v1/agent-runs"),
      (error) => error instanceof RelayApiError
        && error.status === 409
        && error.message === "Agent Hawkeye has no eligible runtime placement (workspace_unavailable).",
    );
  });

  it("surfaces plain-text errors as RelayApiError instead of JSON parse failures", async () => {
    globalThis.fetch = (async () => new Response("upstream gateway failed", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "Content-Type": "text/plain" },
    })) as typeof fetch;

    await assert.rejects(
      () => apiJson("/api/v1/threads"),
      (error) => error instanceof RelayApiError
        && error.status === 502
        && error.message === "upstream gateway failed",
    );
  });

  it("lists employee-owned logical agents", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    assert.deepEqual(await listEmployeeAgents(), { agents: [] });
    assert.equal(requestedUrl, "/api/v1/agents");
  });

  it("requests compact thread summaries for background polling", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    assert.deepEqual(await listSessionSummaries(), { sessions: [] });
    assert.equal(requestedUrl, "/api/v1/threads?view=summary");
  });

  it("updates employee-owned logical agent metadata", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        agent: {
          id: "agent_research",
          displayName: "Analyst",
          instructions: "Cite sources.",
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const result = await updateOwnEmployeeAgent("agent_research", {
      displayName: "Analyst",
      instructions: "Cite sources.",
    });

    assert.equal(requestUrl, "/api/v1/agents/agent_research");
    assert.deepEqual(requestBody, { displayName: "Analyst", instructions: "Cite sources." });
    assert.equal(result.agent.displayName, "Analyst");
  });

  it("dispatches work by logical agent id without a sandbox id", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "ses_1", agentRuns: [] }), { status: 202, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    await runLogicalAgents({
      taskGoal: "Build it",
      daemonNodeId: "node_selected",
      assignments: [{ agentId: "agent_builder" }],
      sessionId: "ses_existing",
      userMessageId: "evt_user",
      decision: { kind: "handoff", targetAgent: "codex", note: "Continue here" },
    });

    assert.equal(requestUrl, "/api/v1/agent-runs");
    assert.deepEqual(requestBody, {
      taskGoal: "Build it",
      daemonNodeId: "node_selected",
      assignments: [{ agentId: "agent_builder" }],
      sessionId: "ses_existing",
      userMessageId: "evt_user",
      decision: { kind: "handoff", targetAgent: "codex", note: "Continue here" },
    });
  });

  it("lists artifacts with optional employee and workspace filters", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ artifacts: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await listArtifacts({ employeeId: "alice", workspacePath: "/workspace/alice repo" });

    assert.deepEqual(result, { artifacts: [] });
    assert.equal(requestedUrl, "/api/v1/artifacts?employeeId=alice&workspacePath=%2Fworkspace%2Falice+repo");
  });

  it("lists a task's generated artifacts", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        taskId: "task 1",
        artifacts: [{
          id: "art_deck",
          kind: "workspace_file",
          title: "deck.pptx",
          path: "/workspace/deck.pptx",
          createdAt: "2026-07-01T00:00:00Z",
          sessionId: "ses_1",
          taskId: "task 1",
        }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await listTaskArtifacts("task 1");

    assert.equal(requestedUrl, "/api/v1/tasks/task%201/artifacts");
    assert.equal(result.taskId, "task 1");
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].title, "deck.pptx");
    assert.equal(result.artifacts[0].sessionId, "ses_1");
  });

  it("lists merged task files with path and version options", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        taskId: "task 1",
        produced: [],
        live: { status: "ok", path: "src", entries: [] },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await listTaskFiles({
      taskId: "task 1",
      path: "src",
      allVersions: true,
    });

    assert.equal(
      requestedUrl,
      "/api/v1/tasks/task%201/files?path=src&versions=all",
    );
    assert.equal(result.live.status, "ok");
  });

  it("deletes a task through the task resource", async () => {
    let requestedUrl = "";
    let requestedMethod = "";
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({
        outcome: "deleted",
        task: {
          id: "task 1",
          title: "Retire old task",
          deletedAt: "2026-07-24T00:00:00Z",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await deleteTask("task 1");

    assert.equal(requestedUrl, "/api/v1/tasks/task%201");
    assert.equal(requestedMethod, "DELETE");
    assert.equal(result.outcome, "deleted");
    assert.equal(result.task.deletedAt, "2026-07-24T00:00:00Z");
  });

  it("fetches a workspace brief for a specific employee", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        employeeId: "alice",
        primaryNode: null,
        nodes: [],
        activeRuns: [],
        sessions: [],
        tasks: [],
        artifacts: [],
        metrics: {
          nodeCount: 0,
          activeRunCount: 0,
          sessionCount: 0,
          activeSessionCount: 0,
          taskCount: 0,
          activeTaskCount: 0,
          artifactCount: 0,
        },
        generatedAt: "2026-06-27T00:00:00Z",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await getWorkspaceBrief({ employeeId: "alice" });

    assert.equal(result.employeeId, "alice");
    assert.equal(requestedUrl, "/api/v1/workspace/brief?employeeId=alice");
  });

  it("fetches team-scoped activity", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      const body = {
        employeeId: "alice",
        teamId: "team delivery",
        nodes: [],
        activeRuns: [],
        sessions: [],
        tasks: [],
        artifacts: [],
        metrics: {
          nodeCount: 0,
          activeRunCount: 0,
          sessionCount: 0,
          activeSessionCount: 0,
          taskCount: 0,
          activeTaskCount: 0,
          artifactCount: 0,
        },
        generatedAt: "2026-07-23T00:00:00Z",
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    assert.equal((await getWorkspaceBrief({ teamId: "team delivery" })).teamId, "team delivery");
    assert.deepEqual(requestedUrls, ["/api/v1/workspace/brief?teamId=team+delivery"]);
  });

  it("fetches project-scoped activity", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ projectId: "project/1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    assert.equal((await getWorkspaceBrief({ projectId: "project/1" })).projectId, "project/1");
    assert.equal(requestedUrl, "/api/v1/workspace/brief?projectId=project%2F1");
  });


  it("browses the persistent project workspace without a thread id", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      requestedUrls.push(String(input));
      const preview = String(input).includes("/workspace/file?");
      return new Response(JSON.stringify(preview ? {
        projectId: "project/1",
        scope: "shared",
        source: "live",
        nodeId: "node-1",
        path: "notes/brief.md",
        exists: true,
        isBinary: false,
        bytes: 5,
        content: "hello",
        truncated: false,
        limitBytes: 262144,
        generatedAt: "2026-08-16T00:00:00Z",
      } : {
        projectId: "project/1",
        scope: "shared",
        source: "live",
        nodeId: "node-1",
        path: "notes",
        exists: true,
        entries: [],
        generatedAt: "2026-08-16T00:00:00Z",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await listProjectWorkspaceFiles({ projectId: "project/1", path: "notes" });
    await readProjectWorkspaceFile({ projectId: "project/1", path: "notes/brief.md" });

    assert.deepEqual(requestedUrls, [
      "/api/v1/projects/project%2F1/workspace/files?path=notes",
      "/api/v1/projects/project%2F1/workspace/file?path=notes%2Fbrief.md",
    ]);
  });
});

describe("project mutations", () => {
  it("updates project settings with optimistic versioning", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init?.method),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({ project: { id: "project/1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await updateProject("project/1", {
        expectedVersion: 3,
        name: "Relay GA",
        leadAgentId: "agent-1",
        members: [{
          agentId: "agent-1",
          role: "planner",
          functionTitle: "Lead",
          responsibilities: "Ship",
        }],
      });
    } finally {
      globalThis.fetch = original;
    }

    assert.deepEqual(calls, [{
      url: "/api/v1/projects/project%2F1",
      method: "PATCH",
      body: {
        expectedVersion: 3,
        name: "Relay GA",
        leadAgentId: "agent-1",
        members: [{
          agentId: "agent-1",
          role: "planner",
          functionTitle: "Lead",
          responsibilities: "Ship",
        }],
      },
    }]);
  });

  it("archives the exact project version", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: String(init?.method) });
      return new Response(JSON.stringify({ project: { id: "project/1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await archiveProject("project/1", 4);
    } finally {
      globalThis.fetch = original;
    }

    assert.deepEqual(calls, [{
      url: "/api/v1/projects/project%2F1?expectedVersion=4",
      method: "DELETE",
    }]);
  });
});

describe("agent run payloads", () => {
  it("omits assignments when the message is addressed to the room", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ id: "ses_1" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await runLogicalAgents({ taskGoal: "one more pass", sessionId: "ses_1" });
    } finally {
      globalThis.fetch = original;
    }

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
      taskGoal: "one more pass",
      sessionId: "ses_1",
    });
  });
});

describe("thread collaboration messages", () => {
  it("sends semantic intent without assignment transport details", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ id: "ses_1" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await submitThreadMessage("ses_1", {
        text: "@Support check this",
        intent: "review",
        addressAgentIds: ["agent_support"],
        userMessageId: "evt_1",
      });
    } finally {
      globalThis.fetch = original;
    }

    assert.deepEqual(calls, [{
      url: "/api/v1/threads/ses_1/messages",
      body: {
        text: "@Support check this",
        intent: "review",
        addressAgentIds: ["agent_support"],
        userMessageId: "evt_1",
      },
    }]);
  });

  it("requests recovery without sending assignments or executor details", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ id: "ses_1" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await requestThreadRecovery("ses_1", {
        kind: "handoff",
        targetAgentId: "agent_support",
        note: "fresh eyes",
        idempotencyKey: "recovery_1",
      });
    } finally {
      globalThis.fetch = original;
    }

    assert.deepEqual(calls, [{
      url: "/api/v1/threads/ses_1/recoveries",
      body: {
        kind: "handoff",
        targetAgentId: "agent_support",
        note: "fresh eyes",
        idempotencyKey: "recovery_1",
      },
    }]);
  });
});
