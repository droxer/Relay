import { expect, test, type Locator, type Page } from "@playwright/test";

const stamp = "2026-09-01T00:00:00.000Z";
function task(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, description: "", priority: "normal", status, workflowStage: status,
    ownerEmployeeId: "review-user", assignedAgentId: "agent", acceptancePolicy: "human",
    isRoutine: false, routineEnabled: false, linkedSessionIds: [], createdAt: stamp, updatedAt: stamp,
    eventCount: 1, activityCount: 0, ...extra };
}

/* The board drags with dnd-kit pointer sensors, not HTML5 drag-and-drop, so
   `locator.dragTo` (which dispatches native drag events) cannot drive it.
   Press, travel past the 10px activation distance, then glide to the lane. */
async function dragCard(page: Page, card: Locator, lane: Locator) {
  const from = (await card.boundingBox())!;
  const to = (await lane.boundingBox())!;
  const start = { x: from.x + from.width / 2, y: from.y + from.height - 8 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 24, start.y, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 3, { steps: 12 });
  await page.mouse.up();
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

/** The backlog opens as a list; the lanes live behind the view toggle. */
async function openBoard(page: Page) {
  await page.goto("/backlog");
  await page.locator(".backlog-view-toggle button").first().click();
  await expect(page.locator(".backlog-lane")).toHaveCount(5);
}

/** One Ready task; records whether the board started it (run) or PATCHed it. */
async function mockQueuedTask(page: Page): Promise<string[]> {
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
  return writes;
}

test("dragging Ready to In progress calls execution rather than setting a fake status", async ({ page }) => {
  const writes = await mockQueuedTask(page);
  await openBoard(page);
  await dragCard(page, page.locator('.backlog-lane[data-status="assigned"] article'), page.locator('.backlog-lane[data-status="running"]'));
  await expect.poll(() => writes).toEqual(["run"]);
  await expect(page.locator('.backlog-lane[data-status="assigned"]')).toContainText("Queued delivery");
});

test("a card moves between lanes from the keyboard alone", async ({ page }) => {
  const writes = await mockQueuedTask(page);
  await openBoard(page);
  const card = page.locator('.backlog-lane[data-status="assigned"] article');
  await card.focus();
  await page.keyboard.press("Space");
  await expect(page.locator('.backlog-board[data-dragging="true"]')).toBeVisible();
  // On pickup dnd-kit scrolls the lifted card into view, and the board's
  // horizontal scroll animates there. An arrow key pressed mid-scroll is
  // measured against stale lane positions, so wait for the board to settle.
  await expect(page.locator('[id^="DndLiveRegion"]')).toContainText("is over Ready");
  const board = page.locator(".backlog-board");
  await expect.poll(async () => {
    const before = await board.evaluate((element) => element.scrollLeft);
    await page.waitForTimeout(150);
    return before === await board.evaluate((element) => element.scrollLeft);
  }).toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('.backlog-lane[data-status="running"]')).toHaveAttribute("data-drop", "active");
  await page.keyboard.press("Space");
  await expect.poll(() => writes).toEqual(["run"]);
});

test("Space on a card's checkbox selects it instead of picking the card up", async ({ page }) => {
  const writes = await mockQueuedTask(page);
  await openBoard(page);
  const checkbox = page.locator('.backlog-lane[data-status="assigned"] article').getByRole("checkbox");
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await expect(page.locator('.backlog-board[data-dragging="true"]')).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("the due date is picked from a calendar and kept as a day key", async ({ page }) => {
  await mockQueuedTask(page);
  await page.goto("/backlog");
  await page.getByRole("button", { name: "New task" }).first().click();
  const due = page.getByRole("button", { name: /^Due Pick a date$/ });
  await due.click();
  await page.getByRole("grid").getByRole("button", { name: /14/ }).first().click();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await expect(page.locator('input[name="backlog-due-date"]')).toHaveValue(/^\d{4}-\d{2}-14$/);
  await expect(page.getByRole("button", { name: /^Due .*14/ })).toBeVisible();
  await page.getByRole("button", { name: "Clear date" }).click();
  await expect(page.locator('input[name="backlog-due-date"]')).toHaveValue("");
});
