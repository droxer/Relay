import { expect, test, type Page } from "@playwright/test";

/* The list filter bars are ReUI filter chips over state that still lives in
   the URL. These drive the real chips (the interaction tests stub them). */

const stamp = "2026-09-01T00:00:00.000Z";
const user = { id: "u", employeeId: "u", username: "review", role: "employee", theme: "light", language: "en" };
function task(id: string, priority: string) {
  return { id, title: id, description: "", priority, status: "backlog", workflowStage: "backlog", ownerEmployeeId: "u",
    acceptancePolicy: "human", isRoutine: false, routineEnabled: false, linkedSessionIds: [], createdAt: stamp,
    updatedAt: stamp, eventCount: 1, activityCount: 0 };
}

async function mockApi(page: Page, extra: Record<string, unknown> = {}) {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/auth/me") ? { authenticated: true, user } : {
      tasks: [task("Urgent fix", "high"), task("Tidy docs", "low")],
      sessions: [], agents: [], teams: [], nodes: [], projects: [], sandboxes: [], ...extra,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("a filter is added as a chip, lands in the URL, and filters the list", async ({ page }) => {
  await mockApi(page);
  await page.goto("/backlog");
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByRole("option", { name: /^Priority/ }).click();
  // One condition ("is"), so the value list opens straight away.
  await page.getByRole("option", { name: "High" }).click();
  await expect(page).toHaveURL(/[?&]priority=high\b/);
  const list = page.getByRole("table", { name: "All tasks" });
  await expect(list.getByRole("link", { name: "Urgent fix" })).toBeVisible();
  await expect(list.getByRole("link", { name: "Tidy docs" })).toHaveCount(0);
});

test("a filter in the URL is drawn as a chip, and Clear removes it", async ({ page }) => {
  await mockApi(page);
  await page.goto("/backlog?priority=low");
  const chips = page.locator(".backlog-filter-chips");
  await expect(chips.getByRole("button", { name: "Low" })).toBeVisible();
  await chips.getByRole("button", { name: "Clear" }).click();
  await expect(page).not.toHaveURL(/priority=/);
  await expect(page.getByRole("link", { name: "Tidy docs" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Urgent fix" })).toBeVisible();
});

test("the chip menu offers no rule the URL cannot hold", async ({ page }) => {
  await mockApi(page);
  await page.goto("/backlog?priority=high");
  await page.getByRole("button", { name: "Priority filter options" }).click();
  await expect(page.getByRole("menuitem", { name: "Remove" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Negate" })).toHaveCount(0);
});

test("routines filter by their own fields", async ({ page }) => {
  await mockApi(page);
  await page.goto("/routines");
  await page.getByRole("button", { name: "Add filter" }).click();
  await expect(page.getByRole("option")).toHaveText([/^Type/, /^Cadence/, /^Agent/, /^Assignee/]);
});

test("the agent roster rail filters availability with a chip", async ({ page }) => {
  await mockApi(page);
  await page.goto("/agents");
  const band = page.getByRole("group", { name: "Agent filters" });
  await band.getByRole("button", { name: "Add filter" }).click();
  await page.getByRole("option", { name: /^Availability/ }).click();
  await page.getByRole("option", { name: "Offline" }).click();
  await expect(page).toHaveURL(/[?&]availability=offline\b/);
});
