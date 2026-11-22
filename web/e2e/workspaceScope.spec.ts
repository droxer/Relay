// Full browser -> FastAPI -> daemon -> controlled native process regressions.
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { computerId } from "../src/lib/createAgent";
import type { ControlPanelDaemonNodeRecord } from "../src/types";

test.setTimeout(120_000);

async function post(api: APIRequestContext, path: string, data: object) {
  const response = await api.post(`/api/v1${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function get(api: APIRequestContext, path: string) {
  const response = await api.get(`/api/v1${path}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function setup(page: Page, context: BrowserContext) {
  await post(context.request, "/auth/login", { username: "concurrency", password: "kestrel-vault-7719" });
  await page.addInitScript(() => localStorage.setItem("relay-web.signedIn", "1"));
  let node: ControlPanelDaemonNodeRecord | undefined;
  await expect.poll(async () => {
    node = (await get(context.request, "/admin/daemon-nodes")).nodes.find((n: ControlPanelDaemonNodeRecord) => n.online && n.agents?.codex === "ready");
    return Boolean(node);
  }).toBe(true);
  if (!node) throw Error("Local daemon is not ready");
  const identity = computerId(node);
  const agent = (await get(context.request, "/agents")).agents.find((a: { computerId?: string }) => a.computerId === identity)
    ?? (await post(context.request, "/agents", { displayName: "Scope Agent", computerId: identity, executorKind: "codex", defaultRole: "implementer" })).agent;
  return { node, identity, agent, path: `/computers/${encodeURIComponent(identity)}` };
}
async function stop(api: APIRequestContext, sessionId: string) {
  await post(api, `/threads/${sessionId}/cancellations`, {});
  await expect.poll(async () => (await get(api, `/threads/${sessionId}`)).execution.phase).toBe("terminal");
}
async function taskSession(api: APIRequestContext, taskId: string): Promise<string> {
  let sessionId: string | undefined;
  await expect.poll(async () => {
    const task = await get(api, `/tasks/${taskId}`);
    sessionId = task.linkedSessionIds.at(-1);
    return sessionId;
  }, { message: `Task ${taskId} should acquire a linked session` }).toBeTruthy();
  return sessionId!;
}
function runtimeScope(node: ControlPanelDaemonNodeRecord, relative: string) {
  return JSON.parse(readFileSync(join(node.workspacePath, relative, ".relay/e2e-workspace-scope.json"), "utf8"));
}
async function assertExecution(api: APIRequestContext, node: ControlPanelDaemonNodeRecord, sessionId: string, relative: string, scope: object) {
  await expect.poll(async () => (await get(api, `/threads/${sessionId}`)).execution.phase).toBe("running");
  await expect.poll(() => existsSync(join(node.workspacePath, relative, ".relay/e2e-workspace-scope.json"))).toBe(true);
  const runtime = runtimeScope(node, relative);
  expect(runtime.cwd).toBe(realpathSync(join(node.workspacePath, relative)));
  expect(runtime.scope).toEqual(scope);
}
async function project(api: APIRequestContext, node: ControlPanelDaemonNodeRecord, agentId: string, name: string) {
  return (await post(api, "/projects", { name: `${name} ${randomUUID()}`, daemonNodeId: node.id, leadAgentId: agentId,
    members: [{ agentId, role: "implementer", responsibilities: "Exercise workspace boundaries", enabled: true }] })).project;
}

test("standalone Thread renders real null Project summaries after reload and polling", async ({ page, context }) => {
  const { node, identity, agent, path } = await setup(page, context);
  await page.goto(`${path}/threads/new`);
  await page.getByRole("textbox", { name: `Message ${agent.displayName}`, exact: true }).fill("Scoped standalone Thread");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/computers/[^/]+/threads/(?!new$)[^/]+$`));
  const sessionId = page.url().split("/").at(-1)!;
  try {
    await assertExecution(context.request, node, sessionId, `.threads/${sessionId}`, { computerId: identity });
    const summaries = await get(context.request, "/threads?view=summary&limit=20");
    expect(summaries.sessions.find((s: { id: string }) => s.id === sessionId).projectId).toBeNull();
    await page.reload();
    await expect(page.getByRole("log")).toContainText("Scoped standalone Thread");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    // A real poll must also leave the conversation mounted.
    await page.waitForResponse(r => r.url().includes("/threads?view=summary") && r.status() === 200);
    await expect(page.getByRole("log")).toBeVisible();
  } finally { await stop(context.request, sessionId); }
});

test("Task tool permissions reach a running Codex turn and can be changed in the Thread", async ({ page, context }) => {
  const { agent, identity, path } = await setup(page, context);
  const api = context.request;
  const task = await post(api, "/tasks", {
    title: "Permission probe", computerId: identity, assignedAgentId: agent.id, createSession: true,
  });
  const [sessionId] = task.linkedSessionIds;
  try {
    await page.goto(`${path}/tasks/${task.id}`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit task", exact: true });
    await editor.getByRole("combobox", { name: "Tool permissions" }).click();
    await page.getByRole("option", { name: "YOLO (auto-approve)", exact: true }).click();
    await editor.getByRole("button", { name: "Save task", exact: true }).click();
    await expect.poll(async () => (await get(api, `/tasks/${task.id}`)).permissionMode).toBe("yolo");

    await page.goto(`${path}/threads/${sessionId}`);
    const mode = page.getByRole("combobox", { name: "Tool permissions" });
    await expect(mode).toHaveText(/YOLO/);
    await page.getByRole("textbox", { name: `Message ${agent.displayName}`, exact: true }).fill("Permission probe");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const transcript = page.getByRole("log");
    const thread = () => get(api, `/threads/${sessionId}`);
    const chooseMode = async (option: string) => {
      await mode.click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };
    const answer = async (value: string) => {
      await page.getByRole("textbox", { name: "Your answer", exact: true }).fill(value);
      await page.getByRole("button", { name: "Answer", exact: true }).click();
    };
    await expect(page.getByText("Which color?", { exact: true })).toBeVisible();
    await expect(transcript).toContainText('inherited: {"decision":"accept"}');
    expect((await thread()).execution.permissionMode).toBe("yolo");
    const updated = await api.patch(`/api/v1/tasks/${task.id}`, { data: { permissionMode: "ask" } });
    expect(updated.ok(), await updated.text()).toBeTruthy();
    expect((await thread()).execution.permissionMode).toBe("yolo");
    await expect(mode).toHaveText(/YOLO/);
    await chooseMode("Ask for approval");
    await expect(mode).toHaveText(/Ask/);
    await answer("Blue");
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
    await chooseMode("YOLO · Auto-approve tool requests");
    await expect(transcript).toContainText('pending: {"decision":"accept"}');
    await expect(page.getByText("Which shape?", { exact: true })).toBeVisible();
    await chooseMode("Ask for approval");
    await expect(mode).toHaveText(/Ask/);
    await page.reload();
    await expect(mode).toHaveText(/Ask/);
    await expect(page.getByText("Which shape?", { exact: true })).toBeVisible();
    await answer("Circle");
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(transcript).toContainText('restored: {"decision":"decline"}');
    await expect(transcript).toContainText('first-question: {"answers":{"color":{"answers":["Blue"]}}}');
    await expect(transcript).toContainText('second-question: {"answers":{"shape":{"answers":["Circle"]}}}');
    await expect.poll(async () => (await thread()).execution.phase).toBe("terminal");
    const finished = await thread();
    expect(finished.permissionMode).toBe("ask");
    expect(finished.agentRuns).toHaveLength(1);
    expect(finished.permissionRequests ?? []).toEqual([]);
  } finally {
    const current = await get(api, `/threads/${sessionId}`);
    if (!current.execution.canDelete) await stop(api, sessionId);
    const response = await api.delete(`/api/v1/tasks/${task.id}`);
    expect(response.ok(), await response.text()).toBeTruthy();
  }
});

test("Project roster Automation exposes Run now and dashboard opens its own Tasks", async ({ page, context }) => {
  const { node, identity, agent } = await setup(page, context);
  // Occupy both real daemon slots so Run now must return an accepted queue
  // response without a session, regardless of which scheduler wins the claim.
  const blockers: string[] = [];
  const sessions = new Set<string>();
  let automationId: string | undefined;
  try {
    for (let index = 0; index < 2; index++) {
      const task = await post(context.request, "/tasks", { title: `Capacity blocker ${index}`,
        computerId: identity, assignedAgentId: agent.id });
      blockers.push(task.id);
      await post(context.request, `/tasks/${task.id}/runs`, {});
      const sessionId = await taskSession(context.request, task.id);
      sessions.add(sessionId);
      await assertExecution(context.request, node, sessionId, `tasks/${task.id}`,
        { computerId: identity, taskId: task.id });
    }
    const p = await project(context.request, node, agent.id, "Roster Automation");
    const automation = await post(context.request, "/tasks", { title: "Project crew Automation", projectId: p.id,
      isRoutine: true, routineState: "active", routineTriggers: [] });
    automationId = automation.id;
    await page.goto(`/projects/${p.id}`);
    await page.getByRole("button", { name: "View Project tasks", exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === `/projects/${p.id}` && url.searchParams.get("tab") === "tasks");
    await page.goto(`/projects/${p.id}?tab=automations&automation=${automation.id}`);
    const record = page.getByRole("dialog", { name: automation.title, exact: true });
    const response = page.waitForResponse(r => r.url().endsWith(`/tasks/${automation.id}/runs`) && r.request().method() === "POST");
    await record.getByRole("button", { name: "Run now", exact: true }).click();
    const accepted = await response;
    expect(accepted.status()).toBe(202);
    const started = await accepted.json();
    expect(started.session).toBeNull();
    expect(started.dispatch.state).toBe("queued");
    for (const sessionId of sessions) {
      await stop(context.request, sessionId);
      sessions.delete(sessionId);
    }
    // The scheduler can claim an occurrence before the HTTP caller does.
    // The persisted Task, rather than the initial 202 envelope, owns its link.
    const sessionId = await taskSession(context.request, started.task.id);
    sessions.add(sessionId);
    expect(started.task.projectId).toBe(p.id);
    await assertExecution(context.request, node, sessionId, p.workspaceSubpath,
      { computerId: identity, projectId: p.id, projectWorkspaceSubpath: p.workspaceSubpath,
        taskId: started.task.id, automationId: automation.id });
  } finally {
    for (const sessionId of sessions) await stop(context.request, sessionId);
    for (const taskId of [...blockers, ...(automationId ? [automationId] : [])]) {
      const response = await context.request.delete(`/api/v1/tasks/${taskId}`);
      expect(response.ok(), `Delete ${taskId}: ${response.status()} ${await response.text()}`).toBeTruthy();
    }
  }
});

test("Computer Tasks and Automations keep their files and Project work stays in its Project", async ({ page, context }) => {
  const { node, identity, agent, path } = await setup(page, context);
  const p = await project(context.request, node, agent.id, "Work isolation");
  const records = [
    await post(context.request, "/tasks", { title: "Computer Task", computerId: identity, assignedAgentId: agent.id }),
    await post(context.request, "/tasks", { title: "Computer Automation", computerId: identity, assignedAgentId: agent.id, isRoutine: true, routineState: "active", routineTriggers: [] }),
    await post(context.request, "/tasks", { title: "Project Task", projectId: p.id }),
  ];
  for (const record of records) {
    const started = await post(context.request, `/tasks/${record.id}/runs`, {});
    const sessionId = await taskSession(context.request, started.task.id);
    try {
      const relative = record.projectId ? p.workspaceSubpath : `tasks/${record.id}`;
      await assertExecution(context.request, node, sessionId, relative, {
        computerId: identity,
        ...(record.projectId ? { projectId: p.id, projectWorkspaceSubpath: p.workspaceSubpath } : {}),
        taskId: started.task.id,
        ...(record.isRoutine ? { automationId: record.id } : {}),
      });
    } finally { await stop(context.request, sessionId); }
  }
  await page.goto(`${path}/tasks`);
  await expect(page.getByRole("link", { name: "Computer Task", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Project Task", exact: true })).toHaveCount(0);
  await page.goto(`/projects/${p.id}?tab=tasks`);
  await expect(page.getByRole("link", { name: "Project Task", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Computer Task", exact: true })).toHaveCount(0);
  // A mismatched workspace link is corrected from the stored record.
  await page.goto(`/projects/${p.id}?task=${records[0].id}`);
  await expect(page).toHaveURL(url => url.pathname === `${path}/tasks/${records[0].id}`);
  await page.goto(`/tasks/${records[0].id}?tab=artifacts`);
  await expect(page).toHaveURL(url => url.pathname === `${path}/tasks/${records[0].id}` && url.searchParams.get("tab") === "artifacts");
  await expect(page.getByRole("dialog").getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goto(`/tasks/${records[2].id}?tab=workspace`);
  await expect(page).toHaveURL(url => url.pathname === `/tasks/${records[2].id}` && url.searchParams.get("tab") === "artifacts");
  await expect(page.getByRole("dialog").getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  for (const record of records) expect((await context.request.delete(`/api/v1/tasks/${record.id}`)).ok()).toBeTruthy();
});

test("global Tasks and Automations open Project records in place", async ({ page, context }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const { node, agent } = await setup(page, context);
  const p = await project(context.request, node, agent.id, "Global record routing");
  const records = [
    await post(context.request, "/tasks", { title: "Global Project Task", projectId: p.id }),
    await post(context.request, "/tasks", { title: "Global Project Automation", projectId: p.id,
      isRoutine: true, routineState: "active", routineTriggers: [] }),
  ];
  try {
    for (const record of records) {
      const collection = record.isRoutine ? "automations" : "tasks";
      await page.goto(`/${collection}`);
      const titleLink = page.getByRole("link", { name: record.title, exact: true });
      await expect(titleLink).toBeVisible();
      await titleLink.click();
      await expect(page).toHaveURL(url => url.pathname === `/${collection}/${record.id}`);
      const detail = page.getByRole("dialog", { name: record.title, exact: true });
      await expect(detail).toBeVisible();
      await detail.getByRole("tab", { name: "Files", exact: true }).click();
      await expect(page).toHaveURL(url => url.pathname === `/${collection}/${record.id}` && url.searchParams.get("tab") === "artifacts");
      await page.reload();
      await expect(detail.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page).toHaveURL(url => url.pathname === `/${collection}/${record.id}` && url.searchParams.get("tab") === "artifacts");

      const projectTab = record.isRoutine ? "automations" : "tasks";
      const recordKey = record.isRoutine ? "automation" : "task";
      await page.goto(`/projects/${p.id}?tab=${projectTab}`);
      await page.getByRole("link", { name: record.title, exact: true }).click();
      await expect(detail).toBeVisible();
      await expect(page).toHaveURL(url => url.pathname === `/projects/${p.id}` && url.searchParams.get(recordKey) === record.id);
    }
  } finally {
    for (const record of records) expect((await context.request.delete(`/api/v1/tasks/${record.id}`)).ok()).toBeTruthy();
  }
});
