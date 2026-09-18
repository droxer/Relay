import { expect, test } from "@playwright/test";

const stamp = "2026-09-01T00:00:00.000Z";
function task(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, description: "", priority: "normal", status, workflowStage: status,
    ownerEmployeeId: "review-user", assignedAgentId: "agent", acceptancePolicy: "human",
    isRoutine: false, routineEnabled: false, linkedSessionIds: [], createdAt: stamp, updatedAt: stamp,
    eventCount: 1, activityCount: 0, ...extra };
}

test("five-stage board preserves blocked review and accepts it only after unblocking", async ({ page }) => {
  let tasks = [task("Blocked review", "blocked", { workflowStage: "review", startedAt: stamp, blockedFromStatus: "review", blockerReason: "Need approval", blockedAt: stamp }), task("Queued delivery", "assigned")];
  const writes: Array<{ path: string; body: any }> = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body: any = { sessions: [], agents: [], teams: [], nodes: [], projects: [], sandboxes: [], artifacts: [], events: [], runs: [], files: [], entries: [], tasks, flowPolicy: { wipLimit: 5, scope: "employee" } };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "review-user", employeeId: "review-user", username: "review", role: "employee", theme: "light", language: "en" } };
    if (method === "PATCH" && path.includes("/tasks/")) {
      const input = route.request().postDataJSON();
      writes.push({ path, body: input });
      const id = decodeURIComponent(path.split("/").at(-1)!);
      tasks = tasks.map((item) => item.id === id ? { ...item, status: input.action === "unblock" ? "review" : input.status, workflowStage: input.action === "unblock" ? "review" : input.status, eventCount: item.eventCount + 1 } : item);
      body = { ...tasks.find((item) => item.id === id), events: new Array(tasks.find((item) => item.id === id)!.eventCount).fill({}), activity: [] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/backlog");
  const lanes = page.locator(".backlog-lane");
  await expect(lanes).toHaveCount(5);
  const review = page.locator('.backlog-lane[data-status="review"]');
  const card = review.locator("article").filter({ hasText: "Blocked review" });
  await expect(card).toContainText("Need approval");
  await expect(card.getByRole("button", { name: "Done", exact: true })).toBeDisabled();
  await card.getByRole("button", { name: "Blocked review", exact: true }).click();
  const guidance = page.getByRole("region", { name: "Next steps" });
  await expect(guidance).toContainText("Need approval");
  await expect(guidance).toContainText("Unblock restores the previous stage");
  await page.getByRole("button", { name: "Close drawer", exact: true }).click();
  await card.hover();
  await card.getByRole("button", { name: "Unblock", exact: true }).click();
  await expect(card.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator('.backlog-lane[data-status="done"]')).toContainText("Blocked review");
  expect(writes.map((item) => item.body)).toEqual([{ action: "unblock" }, { status: "done" }]);
  await expect(page.locator('.backlog-lane[data-status="assigned"] article').getByRole("button", { name: "Done", exact: true })).toBeDisabled();
});

test("dragging Ready to In progress calls execution rather than setting a fake status", async ({ page }) => {
  const queued = task("Queued delivery", "assigned");
  const writes: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: any = { tasks: [queued], sessions: [], agents: [], teams: [], nodes: [], projects: [], sandboxes: [], flowPolicy: { wipLimit: 5, scope: "employee" } };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "review-user", employeeId: "review-user", username: "review", role: "employee", theme: "light", language: "en" } };
    if (route.request().method() === "POST" && path.endsWith("/runs")) {
      writes.push("run");
      body = { task: { ...queued, events: [{}], activity: [] }, session: null, dispatch: { state: "queued", code: "task_wip_limit", message: "Finish existing work before starting another task." } };
    }
    if (route.request().method() === "PATCH") writes.push("patch");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/backlog");
  await page.locator('.backlog-lane[data-status="assigned"] article').dragTo(page.locator('.backlog-lane[data-status="running"]'));
  await expect.poll(() => writes).toEqual(["run"]);
  await expect(page.locator('.backlog-lane[data-status="assigned"]')).toContainText("Queued delivery");
});
