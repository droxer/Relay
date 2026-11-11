import assert from "node:assert/strict";
import test from "node:test";
import type { DaemonNodeRunCommand } from "relay-core";
import { assertRunWorkspaceScope } from "../src/run-workspace.js";

const command = (fields: Partial<DaemonNodeRunCommand>): DaemonNodeRunCommand => ({
  id: "cmd", type: "run.start", sessionId: "thread", runId: "run", taskGoal: "Work", agent: "codex", ...fields,
});

test("run commands cannot cross Computer or Project workspace boundaries", () => {
  const base = command({ workspaceLayout: "project", workspaceSubpath: "projects/p", workspaceScope: { computerId: "c", projectId: "p" } });
  assert.doesNotThrow(() => assertRunWorkspaceScope(base, "c"));
  assert.throws(() => assertRunWorkspaceScope({ ...base, workspaceScope: undefined }, "c"), /workspace scope/i);
  for (const fields of [
    { workspaceSubpath: "projects/other" },
    { workspaceLayout: "thread" as const },
    { workspaceLayout: "node-root" as const },
    { workspaceSubpath: "tasks/task" },
    { workspaceScope: { computerId: "elsewhere", projectId: "p" } },
  ]) assert.throws(() => assertRunWorkspaceScope({ ...base, ...fields }, "c"), /workspace scope/i);
});

test("standalone Tasks and Automations can use only their own durable directory", () => {
  const task = command({ workspaceLayout: "task", workspaceSubpath: "tasks/t", workspaceScope: { computerId: "c", taskId: "t" } });
  assert.doesNotThrow(() => assertRunWorkspaceScope(task, "c"));
  assert.throws(() => assertRunWorkspaceScope({ ...task, workspaceSubpath: "tasks/other" }, "c"), /workspace scope/i);
  assert.throws(() => assertRunWorkspaceScope({ ...task, workspaceLayout: "thread" }, "c"), /workspace scope/i);
  const automation = { ...task, workspaceSubpath: "tasks/a", workspaceScope: { computerId: "c", taskId: "occurrence", automationId: "a" } };
  assert.doesNotThrow(() => assertRunWorkspaceScope(automation, "c"));
  assert.throws(() => assertRunWorkspaceScope({ ...automation, workspaceSubpath: "projects/p" }, "c"), /workspace scope/i);
  assert.throws(() => assertRunWorkspaceScope({ ...task, workspaceSubpath: "links/p" }, "c"), /workspace scope/i);
});

test("standalone Threads cannot borrow a durable workspace or an unknown layout", () => {
  const thread = command({ workspaceLayout: "thread", workspaceScope: { computerId: "c" } });
  assert.doesNotThrow(() => assertRunWorkspaceScope(thread, "c"));
  assert.throws(() => assertRunWorkspaceScope({ ...thread, workspaceSubpath: "projects/p" }, "c"), /workspace scope/i);
  assert.throws(() => assertRunWorkspaceScope({ ...thread, workspaceLayout: "unknown" as never }, "c"), /workspace scope/i);
});

test("legacy backends retain contained layouts but cannot cross layout namespaces", () => {
  assert.doesNotThrow(() => assertRunWorkspaceScope(command({ workspaceLayout: "thread" })));
  assert.doesNotThrow(() => assertRunWorkspaceScope(command({ workspaceLayout: "task", workspaceSubpath: "tasks/t" })));
  assert.doesNotThrow(() => assertRunWorkspaceScope(command({ workspaceLayout: "project", workspaceSubpath: "links/p" })));
  assert.throws(() => assertRunWorkspaceScope(command({ workspaceLayout: "task", workspaceSubpath: "projects/p" })), /workspace scope/i);
  assert.throws(() => assertRunWorkspaceScope(command({ workspaceLayout: "project", workspaceSubpath: "tasks/t" })), /workspace scope/i);
  assert.throws(() => assertRunWorkspaceScope(command({ workspaceLayout: "thread", state: { project_reader: { projectId: "p", agentId: "a", bindingRevision: 1 } } as never })), /workspace scope/i);
  assert.throws(() => assertRunWorkspaceScope(command({ workspaceLayout: "project", workspaceSubpath: "projects/other", state: { project_reader: { projectId: "p", agentId: "a", bindingRevision: 1 } } as never })), /workspace scope/i);
  assert.doesNotThrow(() => assertRunWorkspaceScope(command({ workspaceLayout: "task", workspaceSubpath: "tasks/a/occurrence", workspaceScope: { computerId: "c", taskId: "occurrence", automationId: "a" } }), "c"));
});


test("backend-approved legacy bindings resume without opening another workspace", () => {
  for (const layout of ["thread", "node-root"] as const) {
    const legacy = command({ workspaceLayout: layout, workspaceScope: { computerId: "c", taskId: "t", legacyLayout: layout } as never });
    assert.doesNotThrow(() => assertRunWorkspaceScope(legacy, "c"));
    assert.throws(() => assertRunWorkspaceScope({ ...legacy, workspaceSubpath: "projects/p" }, "c"), /workspace scope/i);
    assert.throws(() => assertRunWorkspaceScope(legacy, "other"), /workspace scope/i);
  }
  assert.doesNotThrow(() => assertRunWorkspaceScope(command({ workspaceLayout: "node-root", workspaceScope: { computerId: "c", legacyLayout: "node-root" } as never }), "c"));
  assert.throws(() => assertRunWorkspaceScope(command({ workspaceLayout: "project", workspaceSubpath: "projects/p", workspaceScope: { computerId: "c", projectId: "p", legacyLayout: "thread" } as never }), "c"), /workspace scope/i);
});

test("linked Project runs use their recorded link identity rather than the Project id", () => {
  // The link is created before the Project and has an independent id.
  const scope = { computerId: "c", projectId: "p", projectWorkspaceSubpath: "links/folder-binding" };
  for (const work of [{}, { taskId: "t" }, { taskId: "occurrence", automationId: "a" }]) {
    const linked = command({ workspaceLayout: "project", workspaceSubpath: scope.projectWorkspaceSubpath,
      workspaceScope: { ...scope, ...work },
      state: { project_reader: { projectId: "p", agentId: "agent", bindingRevision: 1 } } as never });
    assert.doesNotThrow(() => assertRunWorkspaceScope(linked, "c"));
    for (const workspaceSubpath of ["links/other", "links/p", "projects/p", "tasks/t"]) {
      assert.throws(() => assertRunWorkspaceScope({ ...linked, workspaceSubpath }, "c"), /workspace scope/i);
    }
    assert.throws(() => assertRunWorkspaceScope(linked, "other"), /workspace scope/i);
  }
});

test("Project directory authorization cannot escape or override a different layout", () => {
  for (const path of ["projects/other", "tasks/t", "links/../p", "links/.", "links/..", "links/a/b", "links/a\\b", "links/a\u0000b", "/tmp/p"]) {
    const scope = { computerId: "c", projectId: "p", projectWorkspaceSubpath: path };
    assert.throws(() => assertRunWorkspaceScope(command({ workspaceLayout: "project", workspaceSubpath: path, workspaceScope: scope }), "c"), /workspace scope/i);
  }
});
