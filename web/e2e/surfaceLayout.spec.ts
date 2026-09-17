import { expect, test, type Browser, type Page } from "@playwright/test";

/* Layout contracts on real routes, not the design specimen. Each of these
   passed every unit test and every desktop screenshot: they only fail at a
   phone width, on a touch pointer, or when two controls share a row. */

const stamp = "2026-09-01T00:00:00.000Z";
const USER = { id: "review-user", employeeId: "review-user", username: "review", role: "employee", theme: "light", language: "en" };

const reply = [
  { type: "assistant", message: { content: [{ type: "text", text: "Both keys are accepted during cutover.\n\n```ts\nexport const KEYS = [OLD_SIGNING_KEY, NEW_SIGNING_KEY];\n```" }] } },
].map((line) => JSON.stringify(line)).join("\n") + "\n";

const session = {
  id: "review-thread", title: "Rotate the signing key", taskGoal: "Rotate the signing key",
  workspacePath: "/workspace", ownerEmployeeId: "review-user", participants: ["human"],
  status: "completed", phase: "created", createdAt: stamp, updatedAt: stamp,
  agentRuns: [{ id: "run-1", agent: "claude", status: "completed", mode: "action", startedAt: stamp, completedAt: stamp }],
  artifacts: [], decisions: [], collaborationRounds: [], eventCount: 3, artifactCount: 0, runCount: 1,
  events: [
    { id: "e1", type: "agent.started", sessionId: "review-thread", timestamp: stamp, runId: "run-1", agent: "claude", mode: "action" },
    { id: "e2", type: "agent.output", sessionId: "review-thread", timestamp: stamp, runId: "run-1", agent: "claude", stream: "stdout", text: reply },
    { id: "e3", type: "agent.completed", sessionId: "review-thread", timestamp: stamp, runId: "run-1", agent: "claude", status: "completed" },
  ],
};

const routine = {
  id: "routine-1", title: "Weekly ledger reconciliation", description: "", priority: "normal", status: "backlog",
  ownerEmployeeId: "review-user", isRoutine: true, routineType: "task", routineCadence: "weekly", routineEnabled: true,
  linkedSessionIds: [], createdAt: stamp, updatedAt: stamp, eventCount: 1, activityCount: 0,
};

async function openPage(browser: Browser, path: string, touch: boolean): Promise<Page> {
  const context = await browser.newContext(touch
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
    : { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [session], agents: [], teams: [], tasks: [routine], nodes: [], projects: [], sandboxes: [], skills: [] };
    if (pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    if (pathname.endsWith("/threads/review-thread")) body = session;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(path);
  return page;
}

/** How far any descendant paints outside the element's own box, in px. */
function overhang(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => {
    const box = element.getBoundingClientRect();
    let worst = element.scrollWidth - element.clientWidth;
    for (const child of element.querySelectorAll("*")) {
      const rect = child.getBoundingClientRect();
      if (rect.width === 0 || getComputedStyle(child).display === "none") continue;
      worst = Math.max(worst, rect.right - box.right, box.left - rect.left);
    }
    return Math.round(worst);
  });
}

test("code-block copy control stays inside its own box on touch", async ({ browser }) => {
  const page = await openPage(browser, "/threads/review-thread", true);
  const copy = page.locator(".md-fence-copy").first();
  await expect(copy).toBeVisible();
  // Touch pins the control visible over the snippet, so a label spilling out
  // of the 32px box lands on top of the code itself.
  expect(await overhang(page, ".md-fence-copy")).toBeLessThanOrEqual(0);
  await expect(copy).toHaveAccessibleName("Copy code");
  await page.context().close();
});

test("composer agent picker fits its content at phone width", async ({ browser }) => {
  const page = await openPage(browser, "/threads/review-thread", true);
  const picker = page.locator(".chat-agent-select").first();
  await expect(picker).toContainText("No agent available");
  expect(await overhang(page, ".chat-agent-select")).toBeLessThanOrEqual(0);
  await page.context().close();
});

for (const touch of [false, true]) {
  test(`filter bar controls share one height${touch ? " on touch" : ""}`, async ({ browser }) => {
    const page = await openPage(browser, "/routines", touch);
    const controls = [".backlog-filter-search-wrap", ".list-sort-menu", ".backlog-filter-chip"];
    for (const selector of controls) await expect(page.locator(selector).first()).toBeVisible();
    const heights = await Promise.all(controls.map((selector) =>
      page.locator(selector).first().evaluate((element) => element.getBoundingClientRect().height)));
    expect(heights, controls.join(" / ")).toEqual([heights[0], heights[0], heights[0]]);
    // The search frame is a fixed height; its field must not spill out of it.
    expect(await overhang(page, ".backlog-filter-search-wrap")).toBeLessThanOrEqual(0);
    const [frame, field] = await Promise.all([".backlog-filter-search-wrap", ".backlog-filter-search"].map((selector) =>
      page.locator(selector).first().evaluate((element) => element.getBoundingClientRect())));
    expect(field.bottom).toBeLessThanOrEqual(frame.bottom);
    await page.context().close();
  });
}
