import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RelayApiError } from "../src/api-client/client.ts";
import { projectCleanupNotice, projectDeleteErrorMessage } from "../src/lib/projectDeletion.ts";

const names: Record<string, string> = { s1: "Plan launch", s2: "Draft notes", s3: "Review", s4: "Ship" };
const threadName = (id: string) => names[id];

function activeError(sessionIds: string[], taskIds: string[] = []) {
  return new RelayApiError("project_execution_active", 409, "project_execution_active", {
    code: "project_execution_active",
    sessionIds,
    taskIds,
  });
}

const tasks: Record<string, string> = { t1: "Research", t2: "Write up" };
const taskName = (id: string) => tasks[id];

describe("projectCleanupNotice", () => {
  it("warns when cleanup waits on a computer or cannot happen", () => {
    assert.deepEqual(projectCleanupNotice("waiting_for_computer"), {
      key: "project.cleanup_waiting_for_computer", tone: "warn",
    });
    assert.equal(projectCleanupNotice("orphaned").tone, "warn");
    assert.equal(projectCleanupNotice("queued").tone, "info");
  });
});

describe("projectDeleteErrorMessage", () => {
  it("names the threads that block the delete", () => {
    assert.deepEqual(projectDeleteErrorMessage(activeError(["s1", "s2"]), threadName), {
      key: "project.delete_active_threads",
      values: { threads: "Plan launch, Draft notes" },
    });
  });

  it("summarizes blocking threads past the named limit", () => {
    assert.deepEqual(projectDeleteErrorMessage(activeError(["s1", "s2", "s3", "s4"]), threadName), {
      key: "project.delete_active_threads_more",
      values: { threads: "Plan launch, Draft notes, Review", count: 1 },
    });
  });

  it("falls back to the generic message when no blocking thread is loaded", () => {
    assert.deepEqual(projectDeleteErrorMessage(activeError(["missing"]), threadName), {
      key: "project.delete_active",
    });
  });

  it("names the blocking tasks when their threads are not loaded", () => {
    assert.deepEqual(projectDeleteErrorMessage(activeError(["elsewhere"], ["t1", "t2"]), threadName, taskName), {
      key: "project.delete_active_tasks",
      values: { tasks: "Research, Write up" },
    });
  });

  it("prefers naming threads over tasks", () => {
    assert.equal(
      projectDeleteErrorMessage(activeError(["s1"], ["t1"]), threadName, taskName).key,
      "project.delete_active_threads",
    );
  });

  it("explains a stale version and a full command queue", () => {
    const conflict = new RelayApiError("project_version_conflict", 409, "project_version_conflict");
    assert.equal(projectDeleteErrorMessage(conflict, threadName).key, "project.delete_conflict");
    const full = new RelayApiError("project_cleanup_queue_full", 503, "project_cleanup_queue_full", {});
    assert.equal(projectDeleteErrorMessage(full, threadName).key, "project.delete_queue_full");
  });

  it("uses the generic message for anything else", () => {
    assert.equal(projectDeleteErrorMessage(new Error("boom"), threadName).key, "errors.delete_project");
  });
});
