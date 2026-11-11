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
      expect((await context.request.delete(`/api/v1/tasks/${taskId}`)).ok()).toBeTruthy();
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
  await expect(page).toHaveURL(url => url.pathname === `/projects/${p.id}` && url.searchParams.get("recordTab") === "artifacts");
  await expect(page.getByRole("dialog").getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true");
  for (const record of records) expect((await context.request.delete(`/api/v1/tasks/${record.id}`)).ok()).toBeTruthy();
});
