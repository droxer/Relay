import { expect, test } from "@playwright/test";
import type { ProjectRecord, RelayTaskSummary } from "../src/types";

const stamp = "2026-11-26T00:00:00.000Z";
const updatedStamp = "2026-11-26T00:05:00.000Z";

const project: ProjectRecord = {
  id: "proj_manual_done",
  name: "Manual Done Project",
  goal: "Ship manual completion",
  ownerUserId: "u",
  computerId: "c",
  enabled: true,
  members: [{ agentId: "agt_1", role: "implementer", enabled: true }],
  leadAgentId: "agt_1",
  version: 1,
  workspaceLayout: "project",
  workspaceSubpath: "projects/manual-done",
  createdAt: stamp,
  updatedAt: stamp,
};

test("running project task confirms, sends PATCH {status: 'done'}, and updates visibly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const patches: unknown[] = [];
  let task: RelayTaskSummary & { events: unknown[]; activity: unknown[] } = {
    id: "task_proj_running",
    number: 11,
    title: "Running project task",
    description: "Active work in a project.",
    priority: "normal",
    status: "running",
    workflowStage: "running",
    isRoutine: false,
    projectId: project.id,
    ownerUserId: "u",
    assigneeUserId: "u",
    assignedAgentId: "agt_1",
    linkedSessionIds: ["sess_1"],
    createdAt: stamp,
    updatedAt: stamp,
    eventCount: 2,
    activityCount: 0,
    events: [],
    activity: [],
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname: path, searchParams } = new URL(request.url());
    const directory = { ...project, view: "directory", goal: undefined, context: undefined, setup: undefined };
    let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [directory], tasks: [task] };
    if (path.endsWith("/auth/me")) {
      body = { authenticated: true, user: { id: "u", userId: "u", username: "Owner", role: "user", theme: "light", language: "en" } };
    } else if (path.endsWith("/projects") && searchParams.get("view") === "index") {
      body = { projects: [{ id: project.id, name: project.name, enabled: true, version: project.version, memberCount: 1 }] };
    } else if (path.endsWith(`/projects/${project.id}`)) {
      body = { project: searchParams.get("view") === "directory" ? directory : project };
    } else if (path.endsWith(`/tasks/${task.id}`)) {
      if (request.method() === "PATCH") {
        const input = request.postDataJSON();
        patches.push(input);
        task = { ...task, status: input.status, workflowStage: input.status, updatedAt: updatedStamp, eventCount: 3 };
      }
      body = task;
    } else if (path.endsWith(`/tasks/${task.id}/events`)) {
      body = { events: [] };
    } else if (path.endsWith(`/tasks/${task.id}/runs`)) {
      body = { taskId: task.id, runs: [] };
    } else if (path.endsWith(`/tasks/${task.id}/artifacts`)) {
      body = { artifacts: [] };
    } else if (path.endsWith(`/tasks/${task.id}/workspace/status`)) {
      body = { waiting: false };
    }
    await route.fulfill({ status: 200, json: body });
  });

  await page.goto(`/projects/${project.id}?tab=tasks`);
  await page.getByText("Running project task", { exact: true }).click();
  const markDone = page.getByRole("button", { name: "Mark the work done", exact: true });
  await expect(markDone).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toBeVisible();

  // Cancel confirmation leaves task running with no PATCH.
  await markDone.click();
  const dialog = page.getByRole("alertdialog", { name: "Mark the work done" });
  await expect(dialog).toContainText("Mark this task done? Any active work will be asked to stop.");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(patches).toEqual([]);
  await expect(markDone).toBeVisible();

  // Confirm sends PATCH {"status":"done"} and updates visible state immediately.
  await markDone.click();
  await page.getByRole("alertdialog", { name: "Mark the work done" }).getByRole("button", { name: "Mark the work done", exact: true }).click();
  await expect.poll(() => patches).toEqual([{ status: "done" }]);
  await expect(page.getByRole("button", { name: "Mark the work done", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toHaveCount(0);
  await expect(page.locator("#task-record-panel").getByRole("button", { name: /^Status: Completed\./ })).toBeVisible();
});

test("cancelled standalone task confirms, sends PATCH {status: 'done'}, and updates visibly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const patches: unknown[] = [];
  let task: RelayTaskSummary & { events: unknown[]; activity: unknown[] } = {
    id: "task_solo_cancelled",
    number: 12,
    title: "Cancelled standalone task",
    description: "Standalone work previously cancelled.",
    priority: "normal",
    status: "cancelled",
    workflowStage: "cancelled",
    isRoutine: false,
    ownerUserId: "u",
    assigneeUserId: "u",
    linkedSessionIds: [],
    createdAt: stamp,
    updatedAt: stamp,
    eventCount: 2,
    activityCount: 0,
    events: [],
    activity: [],
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname: path } = new URL(request.url());
    let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [], tasks: [] };
    if (path.endsWith("/auth/me")) {
      body = { authenticated: true, user: { id: "u", userId: "u", username: "Owner", role: "user", theme: "light", language: "en" } };
    } else if (path.endsWith(`/tasks/${task.id}`)) {
      if (request.method() === "PATCH") {
        const input = request.postDataJSON();
        patches.push(input);
        task = { ...task, status: input.status, workflowStage: input.status, updatedAt: updatedStamp, eventCount: 3 };
      }
      body = task;
    } else if (path.endsWith(`/tasks/${task.id}/events`)) {
      body = { events: [] };
    } else if (path.endsWith(`/tasks/${task.id}/runs`)) {
      body = { taskId: task.id, runs: [] };
    } else if (path.endsWith(`/tasks/${task.id}/artifacts`)) {
      body = { artifacts: [] };
    } else if (path.endsWith(`/tasks/${task.id}/workspace/status`)) {
      body = { waiting: false };
    }
    await route.fulfill({ status: 200, json: body });
  });

  await page.goto(`/tasks/${task.id}`);
  const markDone = page.getByRole("button", { name: "Mark the work done", exact: true });
  await expect(markDone).toBeVisible();
  await expect(page.getByRole("button", { name: /^Status: Cancelled\./ })).toBeVisible();

  await markDone.click();
  const dialog = page.getByRole("alertdialog", { name: "Mark the work done" });
  await expect(dialog).toContainText("Mark this task done? Any active work will be asked to stop.");
  await dialog.getByRole("button", { name: "Mark the work done", exact: true }).click();

  await expect.poll(() => patches).toEqual([{ status: "done" }]);
  await expect(page.getByRole("button", { name: "Mark the work done", exact: true })).toHaveCount(0);
  await expect(page.locator("#task-record-panel").getByRole("button", { name: /^Status: Completed\./ })).toBeVisible();
});
