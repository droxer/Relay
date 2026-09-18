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

async function openPage(browser: Browser, path: string, touch: boolean, layout?: Record<string, string>, thread?: Record<string, unknown>): Promise<Page> {
  const context = await browser.newContext(touch
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
    : { viewport: { width: 1440, height: 900 } });
  // Seeded before the first script runs: the shell reads its dragged widths
  // out of localStorage on mount, so setting them afterwards would measure a
  // re-render rather than the load the user actually gets.
  if (layout) {
    await context.addInitScript((entries: [string, string][]) => {
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, Object.entries(layout));
  }
  const page = await context.newPage();
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [session], agents: [], teams: [], tasks: [routine], nodes: [], projects: [], sandboxes: [], skills: [] };
    if (pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    if (pathname.endsWith("/threads/review-thread")) body = { ...session, ...thread };
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

/** How far the chat column's own rows paint outside it, in px. Narrower than
 *  overhang(): out-of-flow descendants are skipped, because the shell's hidden
 *  resize inputs are fixed at x=0 and would report ~800px of "bleed" on every
 *  wide window. */
function columnOverhang(page: Page) {
  return page.locator("#chat-panel").evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    let worst = 0;
    for (const child of panel.querySelectorAll("*")) {
      const style = getComputedStyle(child);
      if (style.display === "none" || style.position === "fixed" || style.position === "absolute") continue;
      const rect = child.getBoundingClientRect();
      if (rect.width === 0) continue;
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

/* The shell's rail widths are a two-part contract that no static CSS test can
   check: AppShell writes the DRAGGED width inline on .messenger-shell, and the
   grid track caps it against the viewport. Both halves have to meet on the
   same element.

   They did not. The cap was written as a :root token — `min(var(--thread-w),
   26vw)` — and a custom property is substituted where it is DECLARED, so that
   min() read :root's 318px default and the computed result inherited down past
   the inline override entirely. Every rail rendered at its default width and
   dragging did nothing, while the CSS text still said exactly what it was
   supposed to say. Only a rendered measurement can tell those apart. */
const RAIL_WIDTHS = { sidenav: ".sidenav-panel", rail: ".thread-panel" } as const;

function renderedWidth(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
}

test("a dragged rail width reaches the rendered grid track", async ({ browser }) => {
  // Both widths sit above the defaults (228 / 318) and below the viewport caps
  // at 1440 (18vw = 259, 26vw = 374), so this isolates the override reaching
  // the track from the capping behaviour tested below.
  const page = await openPage(browser, "/threads/review-thread", false, {
    "relay-web.sidenavExpanded": "true",
    "relay-web.sidenavWidth": "250",
    "relay-web.threadListWidth": "360",
  });
  await expect(page.locator(RAIL_WIDTHS.rail).first()).toBeVisible();
  expect(await renderedWidth(page, RAIL_WIDTHS.sidenav)).toBe(250);
  expect(await renderedWidth(page, RAIL_WIDTHS.rail)).toBe(360);
  await page.context().close();
});

test("the viewport cap overrides a dragged width that no longer fits", async ({ browser }) => {
  // Dragged wide on a big monitor, then opened at 1440: the rails yield to the
  // transcript instead of holding a width the window can no longer afford.
  const page = await openPage(browser, "/threads/review-thread", false, {
    "relay-web.sidenavExpanded": "true",
    "relay-web.sidenavWidth": "320",
    "relay-web.threadListWidth": "480",
  });
  await expect(page.locator(RAIL_WIDTHS.rail).first()).toBeVisible();
  expect(await renderedWidth(page, RAIL_WIDTHS.sidenav)).toBe(Math.round(0.18 * 1440));
  expect(await renderedWidth(page, RAIL_WIDTHS.rail)).toBe(Math.round(0.26 * 1440));
  await page.context().close();
});

test("the chat column never paints outside itself, however wide the window", async ({ browser }) => {
  // --thread-measure caps the transcript and the composer. It is stated in vw,
  // which measures the WINDOW, while the column it caps is the window minus
  // the rails — so a wide rail is exactly when the cap can exceed its column.
  const page = await openPage(browser, "/threads/review-thread", false, {
    "relay-web.sidenavExpanded": "true",
    "relay-web.sidenavWidth": "320",
    "relay-web.threadListWidth": "480",
  });
  await page.setViewportSize({ width: 2000, height: 1000 });
  await expect(page.locator("#chat-panel")).toBeVisible();
  expect(await columnOverhang(page)).toBeLessThanOrEqual(0);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(scroll).toBeLessThanOrEqual(0);
  await page.context().close();
});

test("a long thread title cannot push the chat column past its track", async ({ browser }) => {
  /* The shell clips rather than scrolls (.messenger-shell is overflow:hidden),
     so a chat row wider than its column is cut off mid-word at the window edge
     with nothing to scroll and no error — the failure looks like a rendering
     bug and is really a min-width one.

     .chat-panel sets min-width:0 for exactly this reason, but its ROWS are
     grid items of their own and default to min-width:auto, so the header's
     min-content width — a long title plus a status pill plus participants —
     became a floor the column could not honour. */
  const page = await openPage(browser, "/threads/review-thread", false, { "relay-web.sidenavExpanded": "true" }, {
    title: "Lastest AI News Search and summarize the latest news about AI / LLM / Agents",
    taskGoal: "Lastest AI News Search and summarize the latest news about AI / LLM / Agents",
    status: "waiting_for_human",
    participants: ["human", "Franker", "James", "Jeff Dean"],
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.locator(".chat-header")).toBeVisible();
  expect(await columnOverhang(page)).toBeLessThanOrEqual(0);
  await page.context().close();
});
