import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AgentTeam, ProjectRecord, Workflow } from "../src/types.ts";

import {
  apiJson,
  archiveProject,
  unarchiveProject,
  deleteProject,
  archiveSession,
  assignControlPanelDaemonNode,
  assignTask,
  cancelRun,
  deleteTask,
  getWorkspaceBrief,
  getTeamMemberChoices,
  listProjectWorkspaceFiles,
  listArtifacts,
  listUserAgents,
  listTeams,
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
  updateOwnUserAgent,
  updateProject,
  updateTeamMemberConfig,
  updateUserPreferences,
  updateWorkflowDraft,
} from "../src/api.js";

const originalFetch = globalThis.fetch;

describe("apiJson", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("expands a compact Team roster once, preserving member order and workflow defaults", async () => {
    const lead = { id: "lead", displayName: "Lead" };
    const reviewer = { id: "reviewer", displayName: "Reviewer" };
    const preset = { id: "preset:build_review", name: "Build and review", kind: "predefined", enabled: true };
    const custom = { id: "release", name: "Release", kind: "steps", enabled: true, version: 4, stepAgentIds: [reviewer.id] };
    const row = { id: "team", version: 2, memberAgentIds: [reviewer.id, lead.id, "removed"],
      leadAgentId: lead.id, defaultWorkflowId: custom.id, workflowOptions: [custom] };
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input), "http://relay.local");
      assert.equal(url.pathname, "/api/v1/teams");
      assert.equal(url.searchParams.get("view"), "summary");
      assert.equal(url.searchParams.get("format"), "compact");
      calls++;
      if (calls === 2) {
        assert.equal(url.searchParams.get("relayRevision"), 'W/"roster"');
        assert.equal(new Headers(options?.headers).get("if-none-match"), null);
        return new Response(null, { status: 304 });
      }
      return Response.json({
        view: "summary", teams: [row, { ...row, id: "other", leadAgentId: "removed" }],
        memberDirectory: [lead, reviewer], predefinedWorkflows: [preset],
      }, { headers: { etag: 'W/"roster"' } });
    }) as typeof fetch;

    const options = { view: "summary" as const, cache: {} };
    const roster = await listTeams(undefined, options);
    assert.deepEqual(roster.teams[0], { ...row, members: [reviewer, lead], lead, workflowOptions: [preset, custom] });
    assert.equal(roster.teams[0].members[0], roster.teams[1].members[0]);
    assert.equal(roster.teams[1].lead, null);
    assert.equal(await listTeams(undefined, options), roster);
    assert.equal(calls, 2);
  });

  it("filters Agent choices locally when an older server lacks the Team endpoint", async () => {
    const team = { id: "team", computerId: "here", memberAgentIds: ["member"] } as AgentTeam;
    const here = { id: "available", computerId: "here", placements: [] };
    const member = { id: "member", computerId: "there", placements: [] };
    const other = { id: "other", computerId: "there", placements: [] };
    const reads: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      reads.push(path);
      if (path.endsWith("/member-choices")) return Response.json({ detail: "Not found." }, { status: 404 });
      return Response.json({ agents: [here, member, other] });
    }) as typeof fetch;

    assert.deepEqual(await getTeamMemberChoices(team), { computerId: "here", agents: [here, member] });
    assert.deepEqual(reads, ["/api/v1/teams/team/member-choices", "/api/v1/agents?view=summary"]);
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
    await assignControlPanelDaemonNode({ nodeId: "node 1", userId: "alice" });

    assert.deepEqual(requests, [
      { path: "/api/v1/threads/thread%201", method: "PATCH", body: { title: "Roadmap" } },
      { path: "/api/v1/threads/thread%201", method: "PATCH", body: { archived: true } },
      { path: "/api/v1/threads/thread%201/cancellations", method: "POST", body: { reason: "Cancelled from Relay Web UI." } },
      { path: "/api/v1/tasks/task%201/assignment", method: "PUT", body: { agentId: "agent 1" } },
      { path: "/api/v1/tasks/task%201/runs", method: "POST", body: {} },
      { path: "/api/v1/tasks/task%202/runs", method: "POST", body: { assignments: [{ agentId: "agent selected" }] } },
      { path: "/api/v1/admin/daemon-nodes/node%201/assignment", method: "PUT", body: { userId: "alice" } },
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

  it("lists user-owned logical agents", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    assert.deepEqual(await listUserAgents(), { agents: [] });
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

  it("updates user-owned logical agent metadata", async () => {
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

    const result = await updateOwnUserAgent("agent_research", {
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

  it("lists artifacts with optional user and workspace filters", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ artifacts: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await listArtifacts({ userId: "alice", workspacePath: "/workspace/alice repo" });

    assert.deepEqual(result, { artifacts: [] });
    assert.equal(requestedUrl, "/api/v1/artifacts?userId=alice&workspacePath=%2Fworkspace%2Falice+repo");
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

  it("fetches a workspace brief for a specific user", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        userId: "alice",
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

    const result = await getWorkspaceBrief({ userId: "alice" });

    assert.equal(result.userId, "alice");
    assert.equal(requestedUrl, "/api/v1/workspace/brief?userId=alice");
  });

  it("fetches team-scoped activity", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      const body = {
        userId: "alice",
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
          responsibilities: "Ship",
        }],
      },
    }]);
  });

  it("applies a compact member update to its original revision without another read", async () => {
    const kept = { agentId: "reviewer", role: "reviewer" as const, responsibilities: "Review", enabled: true };
    const base = {
      id: "project/1", version: 3, leadAgentId: "agent-1", managerAgentId: "agent-1",
      members: [{
        agentId: "agent-1", role: "implementer", responsibilities: "Build", instructions: "Long instructions",
        enabled: true, projectManager: true,
      }, kept],
    } as ProjectRecord;
    const input = {
      expectedVersion: 3, leadAgentId: "agent-2", memberChange: { op: "add" as const, agentId: "agent-2",
        fields: { responsibilities: "Plan", enabled: true } },
    };
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({ projectMemberUpdate: {
        id: "project/1", baseVersion: 3, version: 4, leadAgentId: "agent-2", managerAgentId: "agent-2", updatedAt: "2026-11-20T00:00:00Z",
        memberChanges: [
          { op: "update", agentId: "agent-1", fields: { projectManager: null } },
          { op: "add", agentId: "agent-2", fields: { ...input.memberChange.fields, role: "planner", projectManager: true } },
        ],
      } });
    }) as typeof fetch;
    try {
      const { project } = await updateProject(base.id, input, base);
      assert.equal(project.version, 4);
      assert.equal(project.leadAgentId, "agent-2");
      assert.deepEqual(project.members, [
        { agentId: "agent-1", role: "implementer", responsibilities: "Build", instructions: "Long instructions", enabled: true },
        kept,
        { agentId: "agent-2", ...input.memberChange.fields, role: "planner", projectManager: true },
      ]);
      assert.equal(project.members[1], kept);
      assert.equal(base.members[0].projectManager, true);
      assert.deepEqual(calls, [{ url: "/api/v1/projects/project%2F1?view=member-update", method: "PATCH", body: input }]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reads the saved Project if the response belongs to a different base revision", async () => {
    const base = { id: "project/1", version: 3, members: [] } as unknown as ProjectRecord;
    const saved = { ...base, version: 5 };
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      return Response.json(init?.method === "PATCH" ? { projectMemberUpdate: {
        id: base.id, baseVersion: 4, version: 5, memberChanges: [],
      } } : { project: saved });
    }) as typeof fetch;
    try {
      assert.deepEqual(await updateProject(base.id, { expectedVersion: 3, leadAgentId: null }, base), { project: saved });
      assert.deepEqual(calls, [
        "PATCH /api/v1/projects/project%2F1?view=member-update",
        "GET /api/v1/projects/project%2F1",
      ]);
    } finally {
      globalThis.fetch = original;
    }
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
      url: "/api/v1/projects/project%2F1/archive?expectedVersion=4",
      method: "POST",
    }]);
  });

  it("unarchives the exact project version", async () => {
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
      await unarchiveProject("project/1", 5);
    } finally {
      globalThis.fetch = original;
    }

    assert.deepEqual(calls, [{
      url: "/api/v1/projects/project%2F1/unarchive?expectedVersion=5",
      method: "POST",
    }]);
  });

  it("permanently deletes the exact project version", async () => {
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
      await deleteProject("project/1", 4);
    } finally {
      globalThis.fetch = original;
    }

    assert.deepEqual(calls, [{
      url: "/api/v1/projects/project%2F1?expectedVersion=4",
      method: "DELETE",
    }]);
  });
});

describe("team member edits", () => {
  const team = {
    id: "team/one", version: 4, updatedAt: "before",
    memberConfigs: { lead: { role: "planner" }, "builder/one": { role: "implementer", expectedOutputs: ["Keep build notes"] } },
  } as unknown as AgentTeam;

  it("applies only the saved fields for a matching Team revision", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      assert.deepEqual(JSON.parse(String(init?.body)), { responsibility: "Build" });
      return Response.json({ teamMemberUpdate: {
        teamId: team.id, agentId: "builder/one", baseVersion: 4, version: 5, updatedAt: "after",
        fields: { responsibility: "Build" },
      } });
    }) as typeof fetch;
    try {
      const result = await updateTeamMemberConfig(team, "builder/one", { responsibility: "Build" });
      assert.equal(result.baseVersion, 4);
      assert.deepEqual(result.team.memberConfigs?.["builder/one"], { role: "implementer", expectedOutputs: ["Keep build notes"], responsibility: "Build" });
      assert.equal(result.team.memberConfigs?.lead, team.memberConfigs?.lead);
      assert.deepEqual(calls, ["PATCH /api/v1/teams/team%2Fone/members/builder%2Fone"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads the changed Team once when another writer advanced its revision", async () => {
    const calls: string[] = [];
    const latest = { ...team, version: 6 };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      return Response.json(init?.method === "PATCH" ? { teamMemberUpdate: {
        teamId: team.id, agentId: "builder/one", baseVersion: 5, version: 6, fields: { responsibility: "Build" },
      } } : { team: latest });
    }) as typeof fetch;
    try {
      assert.deepEqual(await updateTeamMemberConfig(team, "builder/one", { responsibility: "Build" }), { team: latest });
      assert.deepEqual(calls, [
        "PATCH /api/v1/teams/team%2Fone/members/builder%2Fone",
        "GET /api/v1/teams/team%2Fone?view=preview",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("workflow edits", () => {
  const first = { id: "first", name: "Plan", agentId: "lead", instructions: "Draft the plan", acceptanceCriteria: ["Verified"], requiresApproval: true };
  const second = { ...first, id: "second", name: "Build" };
  const third = { ...second, id: "third", name: "Review" };
  const workflow: Workflow = {
    id: "workflow/one", projectId: "project", version: 8, name: "Release", enabled: true,
    createdAt: "before", updatedAt: "before", workflowSteps: [first, second],
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reconstructs a reordered workflow from only the saved step fields", async () => {
    const calls: string[] = [];
    const { id, ...newStep } = third;
    const changes = { workflowStepChanges: { order: [id, first.id], byId: { [id]: newStep, first: { name: "Plan release" } } } };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      assert.deepEqual(JSON.parse(String(init?.body)), { ...changes, expectedVersion: 8 });
      return Response.json({ workflowUpdate: {
        id: workflow.id, name: workflow.name, updatedAt: "after", baseVersion: 8, version: 9, ...changes,
      } });
    }) as typeof fetch;
    const saved = (await updateWorkflowDraft(workflow, changes)).workflow;
    assert.deepEqual(saved, { ...workflow, version: 9, updatedAt: "after", workflowSteps: [third, { ...first, name: "Plan release" }] });
    assert.deepEqual(calls, ["PATCH /api/v1/workflows/workflow%2Fone?view=update"]);
  });

  it("reads the exact workflow once if the response cannot be applied to the draft revision", async () => {
    const calls: string[] = [];
    const latest = { ...workflow, version: 10 };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      return Response.json(init?.method === "PATCH" ? { workflowUpdate: {
        id: workflow.id, name: "Updated", baseVersion: 9, version: 10, workflowStepChanges: {},
      } } : { workflow: latest });
    }) as typeof fetch;
    assert.deepEqual(await updateWorkflowDraft(workflow, { name: "Updated" }), { workflow: latest });
    assert.deepEqual(calls, ["PATCH /api/v1/workflows/workflow%2Fone?view=update", "GET /api/v1/workflows/workflow%2Fone"]);
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
      url: "/api/v1/threads/ses_1/messages?view=compact",
      body: {
        text: "@Support check this",
        intent: "review",
        addressAgentIds: ["agent_support"],
        userMessageId: "evt_1",
      },
    }]);
  });

  it("addresses another team on the thread's computer", async () => {
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
        text: "crew, take it",
        intent: "accomplish",
        addressTeamId: "team_b",
        userMessageId: "evt_1",
      });
    } finally {
      globalThis.fetch = original;
    }

    assert.deepEqual(calls[0]?.body, {
      text: "crew, take it",
      intent: "accomplish",
      addressTeamId: "team_b",
      userMessageId: "evt_1",
    });
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
