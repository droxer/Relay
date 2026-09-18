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

/* A rail row with every segment its subline can carry: a status line, an origin
   badge, and an origin name. That is the row the 240px floor has to survive. */
const waiting = {
  id: "waiting-thread", title: "Approve the pricing copy", taskGoal: "Approve the pricing copy",
  workspacePath: "/workspace", ownerEmployeeId: "review-user", participants: ["human"],
  status: "waiting_for_human", phase: "created", createdAt: stamp, updatedAt: stamp,
  agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [],
  eventCount: 1, artifactCount: 0, runCount: 0, events: [],
};

const task = {
  id: "task-1", title: "Reconcile September invoices against the ledger export", description: "",
  priority: "high", status: "backlog", ownerEmployeeId: "review-user", isRoutine: false,
  linkedSessionIds: ["review-thread", "waiting-thread"], createdAt: stamp, updatedAt: stamp, eventCount: 1, activityCount: 0,
};

const routine = {
  id: "routine-1", title: "Weekly ledger reconciliation", description: "", priority: "normal", status: "backlog",
  ownerEmployeeId: "review-user", isRoutine: true, routineType: "task", routineCadence: "weekly", routineEnabled: true,
  linkedSessionIds: [], createdAt: stamp, updatedAt: stamp, eventCount: 1, activityCount: 0,
};

/* Enough turns, each long enough, that the transcript scrolls and the rows
   above the fold are render-skipped. */
const longThreadEvents = Array.from({ length: 12 }, (_, turn) => {
  const paragraph = `Lehane says **no antitrust waiver is needed** (airline analogy) — that's a different ask from Amodei's essay, which floated a "narrow governance waiver." The digest had blurred them. Turn ${turn}.`;
  const text = [
    { type: "assistant", message: { content: [{ type: "text", text: [paragraph, paragraph, paragraph].join("\n\n") }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
  return [
    { id: `l${turn}-a`, type: "agent.started", sessionId: "review-thread", timestamp: stamp, runId: `run-l${turn}`, agent: "claude", mode: "action" },
    { id: `l${turn}-b`, type: "agent.output", sessionId: "review-thread", timestamp: stamp, runId: `run-l${turn}`, agent: "claude", stream: "stdout", text },
    { id: `l${turn}-c`, type: "agent.completed", sessionId: "review-thread", timestamp: stamp, runId: `run-l${turn}`, agent: "claude", status: "completed" },
  ];
}).flat();

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
    let body: unknown = { sessions: [session, waiting], agents: [], teams: [], tasks: [task, routine], nodes: [], projects: [], sandboxes: [], skills: [] };
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

test("opening the files panel narrows the conversation instead of cutting it", async ({ browser }) => {
  /* The panel takes its width from the chat column, so every row in the
     transcript has to reflow into what is left. When one does not, the shell
     (overflow:hidden) cuts it mid-word at the panel's edge: no scrollbar, no
     error, just sentences that stop.

     The sibling test above proves the column holds with the panel CLOSED, which
     is the state every other layout test runs in — the panel is the thing that
     moves the column's right edge while its content is already laid out. */
  const page = await openPage(browser, "/threads/review-thread", false, { "relay-web.sidenavExpanded": "true" }, {
    title: "Lastest AI News Search and summarize the latest news about AI / LLM / Agents",
    taskGoal: "Lastest AI News Search and summarize the latest news about AI / LLM / Agents",
    participants: ["human", "Franker", "James", "Jeff Dean"],
    events: longThreadEvents,
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.locator("#chat-panel")).toBeVisible();
  /* Scrolled, and long enough that turns above the fold are render-skipped
     (.msg carries content-visibility:auto). A skipped turn holds the size it
     last rendered at, so the reflow the panel forces has to reach them too —
     measuring only what is on screen at the moment of the click would miss
     exactly the rows the user scrolls back up to. */
  await page.locator(".transcript").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.getByRole("button", { name: "Toggle the files panel" }).click();
  await expect(page.locator(".thread-space-panel")).toBeVisible();
  expect(await columnOverhang(page)).toBeLessThanOrEqual(0);
  await page.locator(".transcript").evaluate((el) => { el.scrollTop = 0; });
  expect(await columnOverhang(page)).toBeLessThanOrEqual(0);
  await page.context().close();
});

test("an open file gets one chrome row, level with the conversation beside it", async ({ browser }) => {
  /* The panel used to spend a full header naming itself and then open the file
     under a second bar — two rows of chrome in a column that can be 288px wide,
     with the panel's content sitting a whole header below the transcript's. The
     file's own header is now the panel's only chrome row: back and close at the
     two ends, the filename and its actions in between. */
  const page = await openPage(browser, "/threads/review-thread", false, { "relay-web.sidenavExpanded": "true" }, {
    artifacts: [{
      id: "art-1", sessionId: "review-thread", kind: "plan", title: "AI-NEWS-2026-09-19.md",
      path: "AI-NEWS-2026-09-19.md", createdAt: stamp, runId: "run-1", contentType: "text/markdown",
    }],
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByRole("button", { name: "Toggle the files panel" }).click();
  await page.locator(".thread-space-row").first().click();

  const header = page.locator(".thread-space-panel .artifact-preview-header");
  await expect(header).toBeVisible();
  // The panel's identity row is gone, not merely emptied.
  await expect(page.locator(".thread-space-header")).toHaveCount(0);
  // Back and close both present, at opposite ends of one row.
  const back = page.locator(".thread-space-panel .file-pane-back");
  const close = page.locator(".thread-space-panel .artifact-preview-header button").last();
  await expect(back).toBeVisible();
  const [backBox, closeBox, headerBox, chatHeaderBox] = await Promise.all([
    back.boundingBox(), close.boundingBox(),
    header.boundingBox(), page.locator(".chat-header").boundingBox(),
  ]);
  expect(backBox!.x).toBeLessThan(closeBox!.x);
  // One row, and the file's first line starts level with the transcript's.
  expect(Math.round(headerBox!.height)).toBe(Math.round(chatHeaderBox!.height));
  expect(Math.round(headerBox!.y + headerBox!.height))
    .toBe(Math.round(chatHeaderBox!.y + chatHeaderBox!.height));
  await page.context().close();
});

/* Controls that the layout cuts in half are controls the user cannot use. Both
   of these are clipping, not overflow: the ancestor is overflow:hidden, so
   nothing scrolls and nothing reports a scrollWidth — the only evidence is a
   child box reaching past its parent's. */

/** Every child of `selector` that paints outside it, worst first. */
function clippedChildren(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((box) => {
    const bb = box.getBoundingClientRect();
    return [...box.querySelectorAll("*")]
      .map((el) => ({ el, r: el.getBoundingClientRect(), cs: getComputedStyle(el) }))
      .filter(({ r, cs }) => r.width > 0 && cs.display !== "none" && cs.position !== "fixed")
      .map(({ el, r }) => ({
        what: (el.getAttribute("aria-label") || el.tagName).trim(),
        over: Math.round(Math.max(r.right - bb.right, bb.left - r.left)),
      }))
      .filter((x) => x.over > 1)
      .sort((a, b) => b.over - a.over);
  });
}

test("a backlog card keeps its action buttons inside the card on touch", async ({ browser }) => {
  /* The coarse-pointer block in a11y.css raises every action icon to the 44px
     touch target. That is the right call on its own, but the card's foot row
     was sized for the smaller desktop icons, so the enlarged row ran past a
     card that is overflow:hidden and the trailing button was sliced. The rule
     that exists to make targets reachable was making the last one unreachable,
     on every card, in the only layout where it applies. */
  const page = await openPage(browser, "/backlog", true);
  await expect(page.locator(".backlog-task").first()).toBeVisible();
  const clipped = await clippedChildren(page, ".backlog-task");
  expect(clipped, JSON.stringify(clipped)).toEqual([]);
  await page.context().close();
});

test("dragging the thread rail moves the rail, and stops where CSS stops it", async ({ browser }) => {
  /* The one interaction none of the tests above performs. Every other check
     seeds a width into localStorage and reloads, which is the shape of test
     that let a dead drag ship: the stored number was right, the CSS text was
     right, and the rail did not move, because the min() capping it was
     declared on :root and never saw the width AppShell writes inline.

     Two things have to hold at once. The rail must land on its ceiling — at
     1300px that is the 26vw cap (338), not the 480px absolute maximum — and
     the stored width must not exceed what CSS will render, or the handle
     climbs away from the edge it is dragging and the gesture feels broken
     while every number still reads correctly. */
  const page = await openPage(browser, "/threads/review-thread", false, { "relay-web.sidenavExpanded": "true" });
  await page.setViewportSize({ width: 1300, height: 900 });
  const handle = page.locator(".thread-panel-resize").first();
  await expect(handle).toBeVisible();

  const railWidth = () => page.locator(".thread-panel").first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const before = await railWidth();
  const box = (await handle.boundingBox())!;
  const y = box.y + box.height / 2;
  const startX = box.x + box.width / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let dx = 20; dx <= 400; dx += 20) await page.mouse.move(startX + dx, y);
  await page.mouse.up();

  const after = await railWidth();
  expect(after).toBeGreaterThan(before);           // it moved at all
  expect(after).toBe(Math.round(0.26 * 1300));     // and stopped at the viewport cap

  // The handle rides the rail's edge, not the pointer: past the ceiling the
  // pointer keeps going and the handle must not.
  const edge = await page.locator(".thread-panel").first().evaluate((el) => Math.round(el.getBoundingClientRect().right));
  const rested = (await handle.boundingBox())!;
  expect(Math.abs(rested.x + rested.width / 2 - edge)).toBeLessThanOrEqual(8);

  // What was stored is what CSS renders — never a number the rail cannot reach.
  const stored = await page.evaluate(() => Number(localStorage.getItem("relay-web.threadListWidth")));
  expect(stored).toBeLessThanOrEqual(after);
  await page.context().close();
});
