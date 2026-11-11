import { expect, test, type Page } from "@playwright/test";

/* The list filter bars are ReUI filter chips over state that still lives in
   the URL. These drive the real chips (the interaction tests stub them). */

const stamp = "2026-09-01T00:00:00.000Z";
const user = { id: "u", userId: "u", username: "review", role: "user", theme: "light", language: "en" };
// Real tasks carry an id and a per-scope number; the row's ref link reads
// "#1", so its name never collides with the title link beside it.
function task(number: number, title: string, priority: string) {
  return { id: `task_${number}`, number, title, description: "", priority, status: "backlog", workflowStage: "backlog", ownerUserId: "u", computerId: "node:filters",
    acceptancePolicy: "human", isRoutine: false, linkedSessionIds: [], createdAt: stamp,
    updatedAt: stamp, eventCount: 1, activityCount: 0 };
}

async function mockApi(page: Page, extra: Record<string, unknown> = {}) {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/auth/me") ? { authenticated: true, user } : {
      tasks: [task(1, "Urgent fix", "high"), task(2, "Tidy docs", "low")],
      sessions: [], agents: [], teams: [], nodes: [{ id: "filters", userId: "u", online: true, stale: false, status: "ready", activeRuns: [], agents: {} }], projects: [], sandboxes: [], ...extra,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("a filter is added as a chip, lands in the URL, and filters the list", async ({ page }) => {
  await mockApi(page);
  await page.goto("/computers/node%3Afilters/tasks");
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByRole("option", { name: /^Priority/ }).click();
  // One condition ("is"), so the value list opens straight away.
  await page.getByRole("option", { name: "High" }).click();
  await expect(page).toHaveURL(/[?&]priority=high\b/);
  const list = page.getByRole("table", { name: "Tasks", exact: true });
  await expect(list.getByRole("link", { name: "Urgent fix" })).toBeVisible();
  await expect(list.getByRole("link", { name: "Tidy docs" })).toHaveCount(0);
});

test("a filter in the URL is drawn as a chip, and Clear removes it", async ({ page }) => {
  await mockApi(page);
  await page.goto("/computers/node%3Afilters/tasks?priority=low");
  const chips = page.locator(".backlog-filter-chips");
  await expect(chips.getByRole("button", { name: "Low" })).toBeVisible();
  await chips.getByRole("button", { name: "Clear" }).click();
  await expect(page).not.toHaveURL(/priority=/);
  await expect(page.getByRole("link", { name: "Tidy docs" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Urgent fix" })).toBeVisible();
});

test("the chip menu offers no rule the URL cannot hold", async ({ page }) => {
  await mockApi(page);
  await page.goto("/computers/node%3Afilters/tasks?priority=high");
  await page.getByRole("button", { name: "Priority filter options" }).click();
  await expect(page.getByRole("menuitem", { name: "Remove" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Negate" })).toHaveCount(0);
});

test("routines filter by their own fields", async ({ page }) => {
  await mockApi(page);
  await page.goto("/computers/node%3Afilters/automations");
  await page.getByRole("button", { name: "Add filter" }).click();
  await expect(page.getByRole("option")).toHaveText([/^Trigger/, /^Agent/, /^Assignee/]);
});

test("the agent roster quick search filters agents and survives reload through the URL", async ({ page }) => {
  const agents = ["Ada", "Ben"].map((name) => ({
    id: name.toLowerCase(), displayName: name, executorKind: "codex", defaultRole: "implementer",
    supervisorUserId: "u", enabled: true, availability: "ready", placements: [], skills: [],
    version: 1, createdAt: stamp, updatedAt: stamp,
  }));
  await mockApi(page, { agents });
  await page.goto("/agents");
  const roster = page.locator(".agents-roster-list");
  await expect(roster.getByRole("button", { name: /Ada/ })).toBeVisible();
  await expect(roster.getByRole("button", { name: /Ben/ })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search agents" }).fill("Ben");
  await expect(page).toHaveURL(/[?&]q=Ben\b/);
  await expect(roster.getByRole("button", { name: /Ada/ })).toHaveCount(0);
  await expect(roster.getByRole("button", { name: /Ben/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Search agents" })).toHaveValue("Ben");
  await expect(roster.getByRole("button", { name: /Ada/ })).toHaveCount(0);
  await expect(roster.getByRole("button", { name: /Ben/ })).toBeVisible();
});
