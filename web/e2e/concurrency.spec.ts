import { expect, test, type APIRequestContext } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computerId } from "../src/lib/createAgent";
import type { ControlPanelDaemonNodeRecord, RelayTask } from "../src/types";

async function post(api: APIRequestContext, path: string, data: object) {
  const response = await api.post(`/api/v1${path}`, { data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("browser, backend and daemon queue overflow and resume after a real process exits", async ({ page, context }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  // No route interception: every browser read and mutation reaches FastAPI.
  await expect.poll(async () => (await context.request.post("/api/v1/auth/login", {
    data: { username: "concurrency", password: "kestrel-vault-7719" },
  })).status()).toBe(200);
  await page.addInitScript(() => localStorage.setItem("relay-web.signedIn", "1"));
  let node: ControlPanelDaemonNodeRecord | undefined;
  await expect.poll(async () => {
    const body = await (await context.request.get("/api/v1/admin/daemon-nodes")).json() as { nodes: ControlPanelDaemonNodeRecord[] };
    node = body.nodes.find(item => item.online && item.agents?.codex === "ready");
    return node?.maxConcurrentRuns;
  }).toBe(2);
  if (!node) throw new Error("Controlled daemon did not register");
  const { agent } = await post(context.request, "/agents", {
    displayName: "Concurrency Agent", computerId: computerId(node),
    executorKind: "codex", defaultRole: "implementer",
  });
  const tasks: RelayTask[] = [];
  const markers: string[] = [];
  const projectIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const { project } = await post(context.request, "/projects", {
      name: `Concurrency ${index}`, daemonNodeId: node.id, leadAgentId: agent.id,
      members: [{ agentId: agent.id, role: "implementer", responsibilities: "Exercise concurrency" }],
    });
    projectIds.push(project.id);
    tasks.push(await post(context.request, "/tasks", {
      title: `Concurrent work ${index}`, projectId: project.id, assignedAgentId: agent.id, status: "backlog",
    }));
    markers.push(join(node.workspacePath, project.workspaceSubpath, ".relay/e2e-agent-started"));
  }
  for (const task of tasks) {
    await page.goto(`/tasks/${task.id}`);
    await page.getByRole("dialog").getByRole("button", { name: "Status: Backlog. Change status", exact: true }).click();
    const [started] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(`/tasks/${task.id}/runs`) && response.request().method() === "POST"),
      page.getByRole("menuitem", { name: "Running", exact: true }).click(),
    ]);
    expect(started.status()).toBe(202);
  }
  const getTask = async (index: number) => (await context.request.get(`/api/v1/tasks/${tasks[index].id}`)).json();
  await expect.poll(async () => (await getTask(2)).dispatchOutcome?.code).toBe("capacity_exhausted");
  await expect.poll(() => markers.slice(0, 2).every(path => existsSync(path))).toBe(true);
  const pids = markers.slice(0, 2).map(path => Number(readFileSync(path, "utf8")));
  expect(pids.every(alive)).toBe(true);
  expect(existsSync(markers[2])).toBe(false);
  await page.goto(`/projects/${projectIds[2]}?tab=tasks`);
  await expect(page.getByText("Queued: this task will start automatically when an execution slot opens on its Computer.", { exact: true })).toBeVisible();

  // The UI requests cancellation; the daemon must prove child exit before
  // the scheduler can dispatch the waiting task without another Run click.
  await page.goto(`/tasks/${tasks[0].id}`);
  await page.getByRole("button", { name: "Cancel run", exact: true }).click();
  await expect.poll(() => alive(pids[0])).toBe(false);
  await expect.poll(() => existsSync(markers[2])).toBe(true);
  await expect.poll(async () => (await getTask(2)).status).toBe("running");
  const thirdPid = Number(readFileSync(markers[2], "utf8"));
  expect(alive(pids[1]) && alive(thirdPid)).toBe(true);
  await page.goto(`/projects/${projectIds[2]}?tab=tasks`);
  await expect(page.getByText("Queued: this task will start automatically when an execution slot opens on its Computer.", { exact: true })).toHaveCount(0);
  for (const index of [1, 2]) {
    await page.goto(`/tasks/${tasks[index].id}`);
    await page.getByRole("button", { name: "Cancel run", exact: true }).click();
  }
  await expect.poll(() => alive(pids[1]) || alive(thirdPid)).toBe(false);
  for (const task of tasks) expect((await context.request.delete(`/api/v1/tasks/${task.id}`)).ok()).toBeTruthy();
});
