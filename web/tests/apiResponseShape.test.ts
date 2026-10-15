import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  apiJson,
  getSession,
  getTask,
  listSessionSummaries,
  listTasks,
  RelayApiError,
  RelayApiShapeError,
} from "../src/api.js";

const originalFetch = globalThis.fetch;
const stamp = "2026-10-15T00:00:00Z";

function respondWith(body: unknown, status = 200): void {
  globalThis.fetch = (async () => new Response(
    body === undefined ? "" : JSON.stringify(body),
    { status, headers: { "Content-Type": "application/json" } },
  )) as typeof fetch;
}

function sessionSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ses_1",
    taskGoal: "Ship it",
    status: "completed",
    phase: "done",
    workspacePath: "/workspace",
    artifactCount: 0,
    runCount: 1,
    eventCount: 3,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...sessionSummary(),
    participants: [],
    agentRuns: [],
    artifacts: [],
    decisions: [],
    collaborationRounds: [],
    events: [],
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task_1",
    title: "Write the report",
    description: "",
    priority: "normal",
    status: "todo",
    isRoutine: false,
    linkedSessionIds: [],
    createdAt: stamp,
    updatedAt: stamp,
    eventCount: 0,
    activityCount: 0,
    ...overrides,
  };
}

/** Run `call` and return the shape error it must reject with. */
async function shapeError(call: () => Promise<unknown>): Promise<RelayApiShapeError> {
  try {
    await call();
  } catch (error) {
    assert.ok(error instanceof RelayApiShapeError, `expected a RelayApiShapeError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to reject");
}

describe("API response shape validation", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("session list", () => {
    it("accepts a valid list, including items without optional fields", async () => {
      const body = { sessions: [sessionSummary(), sessionSummary({ id: "ses_2", title: "Named", archived: true })] };
      respondWith(body);
      assert.deepEqual(await listSessionSummaries(), body);
    });

    it("tolerates fields the client does not know yet", async () => {
      respondWith({ sessions: [sessionSummary({ somethingNew: { nested: true } })], cursor: "next" });
      const result = await listSessionSummaries();
      assert.equal(result.sessions.length, 1);
    });

    it("names the endpoint and the offending item field", async () => {
      respondWith({ sessions: [sessionSummary(), sessionSummary({ updatedAt: 1760486400 })] });
      const error = await shapeError(() => listSessionSummaries());
      assert.equal(error.endpoint, "GET /threads?view=summary");
      assert.equal(error.field, "sessions[1].updatedAt");
      assert.equal(error.status, 200);
      assert.equal(error.code, "invalid_response_shape");
      assert.match(error.message, /GET \/threads\?view=summary/);
      assert.match(error.message, /sessions\[1\]\.updatedAt should be a string, got a number/);
    });

    it("rejects an item that is not an object", async () => {
      respondWith({ sessions: [sessionSummary(), null] });
      const error = await shapeError(() => listSessionSummaries());
      assert.equal(error.field, "sessions[1]");
    });

    it("rejects a list that is not an array", async () => {
      respondWith({ sessions: { ses_1: sessionSummary() } });
      const error = await shapeError(() => listSessionSummaries());
      assert.equal(error.field, "sessions");
      assert.match(error.message, /sessions should be an array, got an object/);
    });

    it("rejects a bare array body", async () => {
      respondWith([sessionSummary()]);
      const error = await shapeError(() => listSessionSummaries());
      assert.equal(error.field, "response");
    });
  });

  describe("single session", () => {
    it("accepts a valid session", async () => {
      respondWith(session({ title: "Named" }));
      const result = await getSession("ses_1");
      assert.equal(result.id, "ses_1");
    });

    it("rejects a session whose event log is missing", async () => {
      const body = session();
      delete body.events;
      respondWith(body);
      const error = await shapeError(() => getSession("ses 1"));
      assert.equal(error.endpoint, "GET /threads/ses%201");
      assert.equal(error.field, "events");
      assert.match(error.message, /events should be an array, got nothing/);
    });

    it("rejects a session without an id", async () => {
      respondWith(session({ id: null }));
      const error = await shapeError(() => getSession("ses_1"));
      assert.equal(error.field, "id");
    });

    it("rejects an empty body", async () => {
      respondWith(undefined);
      const error = await shapeError(() => getSession("ses_1"));
      assert.equal(error.field, "response");
    });

    it("still reports a failed request as the HTTP error, not a shape error", async () => {
      respondWith({ detail: "Thread not found" }, 404);
      await assert.rejects(getSession("ses_1"), (error: unknown) => {
        assert.ok(error instanceof RelayApiError);
        assert.ok(!(error instanceof RelayApiShapeError));
        assert.equal(error.status, 404);
        return true;
      });
    });
  });

  describe("task list", () => {
    it("accepts a valid list", async () => {
      const body = { tasks: [task(), task({ id: "task_2", isRoutine: true, routineState: "active" })], flowPolicy: { wipLimit: 3, scope: "user" } };
      respondWith(body);
      assert.deepEqual(await listTasks(), body);
    });

    it("names the offending task field", async () => {
      respondWith({ tasks: [task(), task(), task({ status: undefined })] });
      const error = await shapeError(() => listTasks());
      assert.equal(error.endpoint, "GET /tasks?view=summary");
      assert.equal(error.field, "tasks[2].status");
    });

    it("rejects a task whose linked sessions are not a list", async () => {
      respondWith({ tasks: [task({ linkedSessionIds: "ses_1" })] });
      const error = await shapeError(() => listTasks());
      assert.equal(error.field, "tasks[0].linkedSessionIds");
    });

    it("rejects a list that is not an array", async () => {
      respondWith({ tasks: null });
      const error = await shapeError(() => listTasks());
      assert.equal(error.field, "tasks");
      assert.match(error.message, /tasks should be an array, got null/);
    });
  });

  describe("single task", () => {
    it("accepts a valid task", async () => {
      respondWith({ ...task(), events: [], activity: [] });
      const result = await getTask("task_1");
      assert.equal(result.title, "Write the report");
    });

    it("rejects a malformed task and names its endpoint", async () => {
      respondWith(task({ title: 7 }));
      const error = await shapeError(() => getTask("task/1"));
      assert.equal(error.endpoint, "GET /tasks/task%2F1");
      assert.equal(error.field, "title");
    });
  });

  describe("apiJson without a guard", () => {
    it("passes the body through unchecked, as before", async () => {
      respondWith({ anything: [1, 2, 3] });
      assert.deepEqual(await apiJson("/whatever"), { anything: [1, 2, 3] });
    });

    it("rethrows a guard's own bugs unchanged", async () => {
      respondWith({ ok: true });
      const bug = new TypeError("guard bug");
      await assert.rejects(apiJson("/whatever", { guard: () => { throw bug; } }), (error) => error === bug);
    });
  });
});
