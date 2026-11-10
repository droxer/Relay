import { expect, test, type Browser, type Page } from "@playwright/test";

/* Layout contracts on real routes, not the design specimen. Each of these
   passed every unit test and every desktop screenshot: they only fail at a
   phone width, on a touch pointer, or when two controls share a row. */

const stamp = "2026-09-01T00:00:00.000Z";
const USER = { id: "review-user", userId: "review-user", username: "review", role: "user", theme: "light", language: "en" };

const reply = [
  { type: "assistant", message: { content: [{ type: "text", text: "Both keys are accepted during cutover.\n\n```ts\nexport const KEYS = [OLD_SIGNING_KEY, NEW_SIGNING_KEY];\n```" }] } },
].map((line) => JSON.stringify(line)).join("\n") + "\n";

const session = {
  id: "review-thread", title: "Rotate the signing key", taskGoal: "Rotate the signing key",
  workspacePath: "/workspace", ownerUserId: "review-user", participants: ["human"],
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
  workspacePath: "/workspace", ownerUserId: "review-user", participants: ["human"],
  status: "waiting_for_human", phase: "created", createdAt: stamp, updatedAt: stamp,
  agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [],
  eventCount: 1, artifactCount: 0, runCount: 0, events: [],
};

const task = {
  id: "task-1", title: "Reconcile September invoices against the ledger export", description: "",
  priority: "high", status: "backlog", ownerUserId: "review-user", isRoutine: false,
  linkedSessionIds: ["review-thread", "waiting-thread"], createdAt: stamp, updatedAt: stamp, eventCount: 1, activityCount: 0,
};

const routine = {
  id: "routine-1", title: "Weekly ledger reconciliation", description: "", priority: "normal", status: "backlog",
  ownerUserId: "review-user", isRoutine: true, routineState: "active",
  routineTriggers: [{ kind: "schedule", schedule: { timezone: "UTC", repeat: { every: "week", at: "09:00", days: [1] } } }],
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

async function openPage(browser: Browser, path: string, touch: boolean, layout?: Record<string, string>, thread?: Record<string, unknown>, fixtures?: Record<string, unknown>): Promise<Page> {
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
    let body: unknown = { sessions: [session, waiting], agents: [], teams: [], tasks: [task, routine], nodes: [], projects: [], sandboxes: [], skills: [], ...fixtures };
    if (pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    if (pathname.endsWith("/threads/review-thread")) body = { ...session, ...thread };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(path);
  return page;
}

for (const touch of [false, true]) {
for (const theme of ["light", "dark"] as const) {
test(`project directory shows aligned names and Agent counts without Computer identifiers (${touch ? "touch" : "pointer"}, ${theme})`, async ({ browser }, testInfo) => {
  const project = {
    id: "fc617e44-b179-4f0a-acf2-1d42a1c49cf7", name: "Relay product development with a very long project name",
    ownerUserId: USER.id, computerId: "device:review-user:mch_mHuvNEUqc-HTHW-GcgxJoA",
    enabled: true, members: [], leadAgentId: null, version: 1,
    workspaceLayout: "project", workspaceSubpath: "projects/relay", createdAt: stamp, updatedAt: stamp,
  };
  const variants = [
    { ...project, id: "short-project", name: "Relay" },
    { ...project, id: "disabled-project", name: "移动端项目列表与协作体验优化长名称验证", enabled: false },
    { ...project, id: "archived-project", name: "UnbrokenProjectNameThatMustWrapWithoutOverflowingThePhoneDirectory", archivedAt: stamp },
  ];
  const page = await openPage(browser, "/projects", touch, { "relay-web.threadListWidth": "240" }, undefined, { projects: [project, ...variants], sessions: [], tasks: [] });
  await page.route("**/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, user: { ...USER, theme } }) }));
  await page.reload();
  const row = page.getByRole("button", { name: `${project.name} · 0 agents`, exact: true });
  await expect(row).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(row).not.toContainText("mch_");
  await expect(row).not.toContainText(project.id);
  await expect(row.locator(".project-folder-meta")).toHaveText("0 agents");
  for (const width of [320, 375, 390, 430, 768, 820, 821, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await row.scrollIntoViewIfNeeded();
    const name = await row.locator(".project-folder-name").boundingBox();
    const meta = await row.locator(".project-folder-meta").boundingBox();
    expect(name).not.toBeNull();
    expect(meta).not.toBeNull();
    expect(Math.abs(name!.x - meta!.x)).toBeLessThan(1);
    expect(meta!.y).toBeGreaterThan(name!.y);
    const rowBox = (await row.boundingBox())!;
    const icon = (await row.locator(".project-folder-icon").boundingBox())!;
    expect(icon.x + icon.width).toBeLessThan(name!.x);
    expect(meta!.y + meta!.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
    // Every row's contents must fit, including the desktop rail's 240px floor.
    for (const item of await page.locator(".project-folder-select").all()) {
      expect(await item.evaluate((button) => [...button.children].every((child) => {
        const row = button.getBoundingClientRect();
        const box = child.getBoundingClientRect();
        return box.left >= row.left && box.right <= row.right && box.top >= row.top && box.bottom <= row.bottom;
      }))).toBe(true);
    }
    if (width <= 820) {
      await expect(row.locator(".project-folder-name")).toHaveCSS("font-size", "17px");
      await expect(row.locator(".project-folder-meta")).toHaveCSS("font-size", "14px");
      const box = (await row.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(76);
      expect(name!.height).toBeLessThanOrEqual(48);
      expect(meta!.y).toBeGreaterThanOrEqual(name!.y + name!.height);
      expect(meta!.y + meta!.height).toBeLessThanOrEqual(box.y + box.height);
      for (const variant of variants) {
        const variantRow = page.getByRole("button", { name: `${variant.name} · 0 agents`, exact: true });
        // These four rows fit in the viewport. Avoid an unnecessary scroll
        // while lazy tooltip wrappers replace their initial bare buttons.
        await expect(variantRow).toBeVisible();
        await expect(variantRow.locator(".project-folder-name")).toBeVisible();
        const bounds = (await variantRow.boundingBox())!;
        expect(bounds.height).toBeGreaterThanOrEqual(76);
        const state = variantRow.locator(".project-folder-count");
        if (await state.count()) {
          await expect(state).toHaveCSS("font-size", "14px");
          const stateBox = (await state.boundingBox())!;
          const countBox = (await variantRow.locator(".project-folder-meta").boundingBox())!;
          const titleBox = (await variantRow.locator(".project-folder-name").boundingBox())!;
          expect(stateBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
          expect(stateBox.x).toBeGreaterThanOrEqual(countBox.x + countBox.width);
          expect(stateBox.x + stateBox.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        }
      }
    } else {
      await expect(row.locator(".project-folder-name")).toHaveCSS("white-space", "nowrap");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if ([320, 768, 1440].includes(width)) {
      await page.screenshot({ path: testInfo.outputPath(`project-directory-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("project-directory.png") });
  await page.keyboard.press("Tab");
  await row.focus();
  await expect(row).toBeFocused();
  await expect(row).toHaveCSS("outline-style", "solid");
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`));
  await page.context().close();
});
}
}

/* The thread rail's project quick filter shares the filter band with the
   search. At the rail's 240px floor the two cannot sit side by side, so the
   select must wrap under the search rather than crush it or bleed past the
   rail; on a phone it is a thumb-height control like the search beside it. */
test("thread rail project filter fits the band and narrows the rail", async ({ browser }, testInfo) => {
  const project = {
    id: "p-launch", name: "Autumn launch with a long enough name to truncate",
    ownerUserId: USER.id, computerId: "device:review-user:main", enabled: true, members: [], leadAgentId: null,
    version: 1, workspaceLayout: "project", workspaceSubpath: "projects/p-launch", createdAt: stamp, updatedAt: stamp,
  };
  // The project's room thread: the unfiltered Threads rail leaves it to the
  // Projects directory; choosing the project must bring it in.
  const room = { ...waiting, id: "room-thread", title: "Launch room", taskGoal: "Launch room", status: "completed", projectId: project.id };
  const fixtures = { projects: [project], sessions: [session, waiting, room] };
  for (const touch of [false, true]) {
    const page = await openPage(browser, "/threads", touch, { "relay-web.threadListWidth": "240" }, undefined, fixtures);
    const rail = page.locator("#thread-panel");
    const filter = rail.getByRole("combobox", { name: "Filter threads by project" });
    await expect(filter).toBeVisible();
    await expect(rail.getByText("Launch room")).toHaveCount(0);
    // In-flow children only: the select's hidden native input is fixed at x=0.
    expect(await page.locator("#thread-panel .list-filter-bar").evaluate((bar) => {
      const box = bar.getBoundingClientRect();
      return Math.max(0, ...[...bar.querySelectorAll("*")]
        .filter((child) => !["fixed", "absolute"].includes(getComputedStyle(child).position))
        .map((child) => Math.max(child.getBoundingClientRect().right - box.right, box.left - child.getBoundingClientRect().left)));
    })).toBeLessThanOrEqual(0);
    const search = await rail.locator(".list-filter-search").boundingBox();
    expect(search!.width).toBeGreaterThanOrEqual(120);
    if (touch) expect((await filter.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for (const theme of ["light", "dark"]) {
      await page.route("**/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, user: { ...USER, theme } }) }));
      await page.reload();
      await expect(filter).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`thread-project-filter-${touch ? "phone" : "desktop"}-${theme}.png`) });
    }
    await filter.click();
    await page.getByRole("option", { name: project.name }).click();
    await expect(filter).toContainText("Autumn launch");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    expect((await rail.locator(".list-filter-search").boundingBox())!.width).toBeGreaterThanOrEqual(120);
    await expect(rail.getByText("Launch room")).toBeVisible();
    await expect(rail.getByText("Approve the pricing copy")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`thread-project-filter-${touch ? "phone" : "desktop"}-chosen.png`) });
    await page.context().close();
  }
});

/* The four collection rails — agents, teams, projects, skills — are one
   surface in four places: a roster heading its own list. They drifted apart
   one page at a time (a page-gutter header over a 12px band, a raw count here
   and a counted noun there, "Publish skill" beside three "New …" actions), so
   the contract is measured on the rendered pages rather than restated in CSS
   comments. Each entry names the rail element; the header is its first child
   and the filter band follows it. */
const COLLECTION_RAILS = [
  ["/agents", ".agents-roster"],
  ["/teams", ".teams-roster"],
  ["/projects", ".thread-panel-inner"],
  ["/skills", ".skills-list"],
] as const;

async function collectionHeader(page: Page, rail: string) {
  return page.locator(`${rail} > .page-header`).evaluate((header) => {
    const title = header.querySelector<HTMLElement>(".page-header-title")!;
    const field = header.parentElement!.querySelector<HTMLElement>(".list-filter-search");
    const icon = field?.querySelector<SVGElement>("svg");
    return {
      display: getComputedStyle(header).display,
      height: Math.round(header.getBoundingClientRect().height * 100) / 100,
      inset: parseFloat(getComputedStyle(header).paddingInlineStart),
      titleSize: getComputedStyle(title).fontSize,
      titleX: Math.round(title.getBoundingClientRect().x),
      fieldX: field ? Math.round(field.getBoundingClientRect().x) : null,
      iconX: icon ? Math.round(icon.getBoundingClientRect().x) : null,
      fieldHeight: field ? Math.round(field.getBoundingClientRect().height * 100) / 100 : null,
      count: header.querySelector(".page-header-count")?.textContent ?? "",
      create: header.querySelector(".page-header-icon-action--primary")?.getAttribute("aria-label") ?? "",
    };
  });
}

test("collection headers share one recipe across agents, teams, projects, and skills", async ({ browser }, testInfo) => {
  const measured = [];
  for (const [path, rail] of COLLECTION_RAILS) {
    const page = await openPage(browser, path, false);
    await expect(page.locator(`${rail} > .page-header`)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${path.slice(1)}-desktop.png`) });
    measured.push({ path, ...await collectionHeader(page, rail) });
    await page.context().close();
  }
  for (const header of measured) {
    expect(header.display, header.path).toBe("flex");
    expect(header.count, header.path).toMatch(/^\d+ \S+$/);
    expect(header.create, header.path).toBe(`New ${header.count.split(" ")[1]!.replace(/s$/, "")}`);
    expect(header.height, header.path).toBe(measured[0]!.height);
    expect(header.inset, header.path).toBe(measured[0]!.inset);
    expect(header.titleSize, header.path).toBe(measured[0]!.titleSize);
    expect(header.fieldHeight, header.path).toBe(measured[0]!.fieldHeight);
    // One left edge: the title, the filter field and its glyph line up, so a
    // rail reads as a column rather than a heading floated over a list.
    expect(header.titleX, header.path).toBe(header.fieldX);
    expect(header.fieldX, header.path).toBe(header.iconX);
  }

  // On a phone the rails drop that heading band — the top bar names the
  // surface — and the create action joins the bar with it, as every other
  // list on this tier does. No thread is seeded, so each rail is the pane on
  // screen; a rail behind an open thread stands down instead (its plus would
  // land on the thread's own bar).
  for (const [path, rail] of COLLECTION_RAILS) {
    const page = await openPage(browser, path, true, undefined, undefined, { sessions: [] });
    expect((await collectionHeader(page, rail)).display, path).toBe("none");
    await page.screenshot({ path: testInfo.outputPath(`${path.slice(1)}-phone.png`) });
    await expect(page.locator(".mobile-topbar-tools").getByRole("button", { name: /^New \S+$/ })).toHaveCount(1);
    await page.context().close();
  }
});

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
    const page = await openPage(browser, "/automations", touch);
    // The chip row's "Add filter" trigger sits on the same rung as the search
    // and the Display glyph, which holds the sort menu on a phone. Above 820px
    // the column headers sort and neither is drawn.
    const controls = [".backlog-filter-search-wrap", ...(touch ? [".backlog-display-trigger"] : []), '.backlog-filter-chips [data-slot="popover-trigger"]'];
    for (const selector of controls) await expect(page.locator(selector).first()).toBeVisible();
    const heights = await Promise.all(controls.map((selector) =>
      page.locator(selector).first().evaluate((element) => element.getBoundingClientRect().height)));
    expect(heights, controls.join(" / ")).toEqual(controls.map(() => heights[0]));
    // The search frame is a fixed height; its field must not spill out of it.
    expect(await overhang(page, ".backlog-filter-search-wrap")).toBeLessThanOrEqual(0);
    const [frame, field] = await Promise.all([".backlog-filter-search-wrap", ".backlog-filter-search"].map((selector) =>
      page.locator(selector).first().evaluate((element) => element.getBoundingClientRect())));
    expect(field.bottom).toBeLessThanOrEqual(frame.bottom);
    await page.context().close();
  });
}

const longRoutine = (id: string, extra: Record<string, unknown>) => ({
  ...routine, id, title: "Quarterly reconciliation of every intercompany ledger export against the treasury statements",
  assignedAgentId: "agent-long", tags: ["finance-close", "quarter-end-review"], ...extra,
});
const phoneRoutines = [
  longRoutine("routine-a", { routineNextRunAt: "2026-12-31T23:30:00.000Z" }),
  longRoutine("routine-b", { routineState: "paused" }),
  { ...routine, id: "routine-c", title: "Short", assignedAgentId: "agent-long", routineNextRunAt: "2026-12-01T09:00:00.000Z" },
];

for (const width of [320, 375, 390, 820]) {
  test(`automation rows stay inside a ${width}px phone and keep Run now tappable`, async ({ browser }) => {
    const page = await openPage(browser, "/automations", true, undefined, undefined, { tasks: phoneRoutines });
    await page.setViewportSize({ width, height: 844 });
    const rows = page.locator(".routine-table > tbody > tr");
    await expect(rows).toHaveCount(phoneRoutines.length);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    // Search, Add filter and the Display glyph share one row, even at 320px.
    const tops = await Promise.all([".backlog-filter-search-wrap", ".backlog-display-trigger", '.backlog-filter-chips [data-slot="popover-trigger"]'].map((selector) =>
      page.locator(selector).first().evaluate((element) => Math.round(element.getBoundingClientRect().top))));
    expect(tops, "filter controls wrapped onto separate rows").toEqual([tops[0], tops[0], tops[0]]);
    for (let index = 0; index < phoneRoutines.length; index += 1) {
      const row = rows.nth(index);
      const metrics = await row.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const inside = (selector: string) => {
          const target = element.querySelector<HTMLElement>(selector);
          if (!target || getComputedStyle(target).display === "none") return null;
          const r = target.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        return {
          box: { left: box.left, right: box.right }, title: inside(".backlog-row-title"), run: inside(".backlog-action-primary"), due: inside(".task-col-due"), assignee: inside(".task-col-assignee"),
          tags: inside(".backlog-row-lead-main > .tag-list"), chip: inside(".backlog-row-lead-main > .tag-list .tag-badge"),
        };
      });
      // The tag box clips chips past the first; it must not clip the first
      // chip itself, which the touch floor makes taller than its drawing.
      if (metrics.tags && metrics.chip) expect(metrics.chip.bottom, "first tag chip is cut off").toBeLessThanOrEqual(metrics.tags.bottom + 0.5);
      for (const part of [metrics.title, metrics.due, metrics.assignee, metrics.run]) {
        if (!part) continue;
        expect(part.left).toBeGreaterThanOrEqual(metrics.box.left - 1);
        expect(part.right).toBeLessThanOrEqual(metrics.box.right + 1);
      }
      expect(metrics.run, "Run now is drawn").not.toBeNull();
      expect(metrics.run!.width).toBeGreaterThanOrEqual(44);
      expect(metrics.run!.height).toBeGreaterThanOrEqual(44);
      // The title never slides under the action.
      expect(metrics.title!.right).toBeLessThanOrEqual(metrics.run!.left + 1);
    }
    if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-${width}.png` });
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
  // Both widths sit above the defaults (228 / 360) and below the viewport caps
  // at 1440 (18vw = 259, 26vw = 374), so this isolates the override reaching
  // the track from the capping behaviour tested below.
  const page = await openPage(browser, "/threads/review-thread", false, {
    "relay-web.sidenavExpanded": "true",
    "relay-web.sidenavWidth": "250",
    "relay-web.threadListWidth": "372",
  });
  await expect(page.locator(RAIL_WIDTHS.rail).first()).toBeVisible();
  expect(await renderedWidth(page, RAIL_WIDTHS.sidenav)).toBe(250);
  expect(await renderedWidth(page, RAIL_WIDTHS.rail)).toBe(372);
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
     file's own header is now the panel's only chrome: back and close at the two
     ends of its first line, level with the conversation's header. In a pane
     under 640px (this one is ~384px) the file's actions take a second line
     (artifact.css, the artifact-preview container query): kept in one row they
     squeezed the filename to nothing and clipped Download off the edge. */
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
  // Back and close share the first line, which starts level with the chat
  // header; the actions line, when the pane is narrow, only ever adds below.
  const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
  expect(Math.abs(middle(backBox!) - middle(closeBox!))).toBeLessThanOrEqual(2);
  expect(Math.round(headerBox!.y)).toBe(Math.round(chatHeaderBox!.y));
  expect(Math.round(headerBox!.height)).toBeGreaterThanOrEqual(Math.round(chatHeaderBox!.height));
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

test("a board card keeps its controls inside the card on touch", async ({ browser }) => {
  /* The coarse-pointer block in a11y.css raises every control to the 44px
     touch target. That is the right call on its own, but a card is
     overflow:hidden and sized for the smaller desktop controls, so an enlarged
     row can run past it and be sliced — the rule that exists to make targets
     reachable making one unreachable, in the only layout where it applies.

     The lanes live on a project's Issues tab, behind the view toggle; the
     global Issues route is a table and draws no cards. */
  const project = { id: "p", name: "Launch", ownerUserId: "review-user", computerId: "c", enabled: true, members: [],
    leadAgentId: null, version: 1, workspaceLayout: "project", workspaceSubpath: "projects/p", createdAt: stamp, updatedAt: stamp };
  const page = await openPage(browser, "/projects/p?tab=tasks", true, undefined, undefined,
    { projects: [project], tasks: [{ ...task, projectId: project.id }] });
  await page.getByRole("button", { name: "Board", exact: true }).click();
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
     1600px that is the 26vw cap (416), not the 480px absolute maximum — and
     the viewport has to be wide enough that the 360px default starts BELOW
     that cap, or there is no room to drag into and "it moved" proves nothing.
     And the stored width must not exceed what CSS will render, or the handle
     climbs away from the edge it is dragging and the gesture feels broken
     while every number still reads correctly. */
  const page = await openPage(browser, "/threads/review-thread", false, { "relay-web.sidenavExpanded": "true" });
  const viewportWidth = 1600;
  await page.setViewportSize({ width: viewportWidth, height: 900 });
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
  expect(after).toBe(Math.round(0.26 * viewportWidth)); // and stopped at the viewport cap

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

test("a task's file preview keeps its header actions inside it on a phone", async ({ browser }) => {
  /* The narrow-pane rules (artifact.css, the artifact-preview container query)
     once sat above the base header rule, so its fixed height and padding won
     and the wrapped actions line was cut off by the header's overflow:hidden. */
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const shipped = {
    id: "ship", title: "Ship the release", projectId: "launch", status: "review", description: "", priority: "normal",
    isRoutine: false, linkedSessionIds: [], ownerUserId: "review-user", createdAt: stamp, updatedAt: stamp, events: [], activity: [],
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [{ id: "launch", name: "Launch", enabled: true, members: [], ownerUserId: "review-user", computerId: "c", createdAt: stamp, updatedAt: stamp }], tasks: [shipped], sandboxes: [], skills: [], files: [], entries: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    if (path.endsWith("/tasks/ship")) body = shipped;
    if (path.endsWith("/tasks/ship/artifacts")) body = { artifacts: [{ id: "notes", sessionId: "run", kind: "workspace_file", title: "release-notes.md", path: "artifacts/release-notes.md", contentType: "text/markdown", bytes: 100, createdAt: stamp }] };
    if (path.endsWith("/threads/run/artifacts/notes")) {
      await route.fulfill({ status: 200, contentType: "text/plain", body: "# Release notes\n\nReady to ship." });
      return;
    }
    if (path.endsWith("/events")) body = { events: [] };
    if (path.endsWith("/runs")) body = { runs: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/tasks/ship?project=launch&tab=workspace");
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("button", { name: /release-notes.md/ }).click();
  const header = drawer.locator(".artifact-preview-header");
  await expect(header).toBeVisible();
  const [headerBox, downloadBox] = await Promise.all([header.boundingBox(), header.locator("a[download]").boundingBox()]);
  expect(downloadBox!.y + downloadBox!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height + 1);
  expect(downloadBox!.x + downloadBox!.width).toBeLessThanOrEqual(headerBox!.x + headerBox!.width + 1);
  await context.close();
});

test("a task record on a phone docks its actions and opens More as a bottom sheet", async ({ browser }) => {
  /* Beside the tabs, "Add to project" covered the third tab; anchored under
     its 28px trigger, the More menu landed mid-screen with 32px rows. On a
     touch phone the labelled actions dock at the bottom edge and the menu
     rises from it at full width (mobile-native.css, task-record.css). */
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const intake = {
    id: "intake", title: "Audit webhook retry backoff", status: "backlog", description: "", priority: "normal",
    isRoutine: false, linkedSessionIds: [], ownerUserId: "review-user", createdAt: stamp, updatedAt: stamp, events: [], activity: [],
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [], tasks: [intake], sandboxes: [], skills: [], files: [], entries: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    if (path.endsWith("/tasks/intake")) body = intake;
    if (path.endsWith("/artifacts")) body = { artifacts: [] };
    if (path.endsWith("/events")) body = { events: [] };
    if (path.endsWith("/runs")) body = { runs: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/tasks/intake");
  const drawer = page.getByRole("dialog");
  const more = drawer.getByRole("button", { name: "More actions" });
  await expect(more).toBeVisible();
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));

  const actions = drawer.locator(".record-drawer-actions");
  const [actionsBox, tabsBox] = await Promise.all([actions.boundingBox(), drawer.locator(".workspace-page-tabs").boundingBox()]);
  expect(actionsBox!.y + actionsBox!.height).toBeCloseTo(844, 0);
  expect(actionsBox!.width).toBeCloseTo(390, 0);
  // The tabs no longer share their row, so none of them sits under an action.
  expect(tabsBox!.y + tabsBox!.height).toBeLessThanOrEqual(actionsBox!.y);

  await more.tap();
  const sheet = page.locator('[data-slot="dropdown-menu-content"]');
  await expect(sheet).toBeVisible();
  // The slide-in may start a frame after the open (WebKit), so wait for the
  // resting position rather than for the animations present right now.
  await expect.poll(async () => {
    const box = await sheet.boundingBox();
    return box ? Math.round(box.y + box.height) : null;
  }).toBe(844);
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox!.x).toBeCloseTo(0, 0);
  expect(sheetBox!.width).toBeCloseTo(390, 0);
  const itemBox = await sheet.getByRole("menuitem").first().boundingBox();
  expect(itemBox!.height).toBeGreaterThanOrEqual(44);
  await context.close();
});

test("the phone tab bar's More sheet sorts pages into the rail's sections", async ({ browser }, testInfo) => {
  /* One flat card used to mix pages, tools, and settings in no rail order.
     The sheet now reads search first, then the desktop rail's sections under
     their own headings, then Sign out alone (MobileMoreSheet.tsx). */
  const page = await openPage(browser, "/home", true);
  const tabs = page.locator(".sidenav-panel .sidenav-btn:visible");
  await expect(tabs).toHaveCount(5);
  await page.getByRole("button", { name: "More pages" }).tap();
  const sheet = page.getByRole("dialog", { name: "More" });
  await expect(sheet).toBeVisible();
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));

  await expect(sheet.locator(".more-sheet-heading")).toHaveText(["Workspace", "Agents and teams", "Resources", "Manage"]);
  await expect(sheet.locator(".more-sheet-nav a")).toHaveText(["Automations", "Agents", "Teams", "Computers", "Skills", "Settings"]);
  const controls = sheet.locator("button, a");
  await expect(controls.first()).toHaveText("Search");
  await expect(controls.last()).toHaveText("Sign out");
  for (const box of await sheet.locator(".more-sheet-row").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().toJSON()))) {
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  await page.screenshot({ path: testInfo.outputPath("more-sheet.png") });
  await page.context().close();
});

test("tapping the current tab again scrolls the screen back to its top", async ({ browser }) => {
  /* A native tab bar's second gesture (SideNav, lib/tabReselect.ts). At the
     tab's root the URL cannot change, so the tap scrolls instead. The pane is
     injected so the test owns a scroller of known height on any fixture. */
  const page = await openPage(browser, "/home", true);
  const homeTab = page.locator('.sidenav-panel [data-nav="home"]');
  await expect(homeTab).toBeVisible();
  await page.evaluate(() => {
    const pane = document.createElement("div");
    pane.id = "reselect-pane";
    pane.style.cssText = "position:fixed;inset:60px 0 auto 0;height:200px;overflow:auto";
    pane.innerHTML = '<div style="height:2000px"></div>';
    document.querySelector(".messenger-shell")!.append(pane);
    pane.scrollTop = 600;
  });
  const pane = page.locator("#reselect-pane");
  expect(await pane.evaluate((element) => element.scrollTop)).toBe(600);

  await homeTab.tap();

  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBe(0);
  expect(new URL(page.url()).pathname).toBe("/home");
  await page.context().close();
});

test("a drawer on a touch phone is dismissed by pulling its header down", async ({ browser }) => {
  /* A full-screen drawer is a sheet on a phone, and the native way out of a
     sheet is to pull it down (Drawer.tsx, useSheetDrag). A short pull springs
     back; a long one closes it. */
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const intake = {
    id: "intake", title: "Audit webhook retry backoff", status: "backlog", description: "", priority: "normal",
    isRoutine: false, linkedSessionIds: [], ownerUserId: "review-user", createdAt: stamp, updatedAt: stamp, events: [], activity: [],
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [], agents: [], teams: [], nodes: [], projects: [], tasks: [intake], sandboxes: [], skills: [], files: [], entries: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    if (path.endsWith("/tasks/intake")) body = intake;
    if (path.endsWith("/artifacts")) body = { artifacts: [] };
    if (path.endsWith("/events")) body = { events: [] };
    if (path.endsWith("/runs")) body = { runs: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/tasks/intake");
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  const head = await drawer.locator(".adm-drawer-head").boundingBox();
  const x = head!.x + head!.width / 3;
  const y = head!.y + head!.height / 2;

  const pull = async (distance: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 5; step += 1) await page.mouse.move(x, y + (distance * step) / 5);
    await page.mouse.up();
  };

  await pull(40);
  await expect(drawer).toBeVisible();
  await expect(drawer).not.toHaveAttribute("data-dragging", "true");
  // Let the spring-back settle, so the next press lands on the header.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));

  await pull(200);
  await expect(drawer).toBeHidden();
  await context.close();
});

/* The Project Lead line carries the lead's name and, for the owner, Discuss,
   its topic menu, and Change — three touch-height controls. On one row a 360px
   phone left the name 30px and a 320px phone none, with Change past the edge,
   so below 480px the controls take their own row and the topics open as the
   phone's action sheet. */
const leadAgent = {
  id: "ada", displayName: "Ada Lovelace-Byron the Analytical", executorKind: "codex", defaultRole: "implementer",
  supervisorUserId: "review-user", enabled: true, availability: "ready", version: 1, skills: [], placements: [],
  createdAt: stamp, updatedAt: stamp,
};
const leadProject = {
  id: "launch", name: "Autumn launch", ownerUserId: "review-user", computerId: "computer", enabled: true,
  members: [{ agentId: "ada", role: "planner", projectManager: true, enabled: true }],
  managerAgentId: "ada", managerThreadId: null, leadAgentId: "ada", version: 1,
  workspaceLayout: "project", workspaceSubpath: "projects/launch", createdAt: stamp, updatedAt: stamp,
};

for (const width of [320, 390]) {
  test(`the Project Lead line keeps the name and its discuss controls inside a ${width}px phone`, async ({ browser }) => {
    const page = await openPage(browser, "/projects/launch", true, undefined, undefined, { agents: [leadAgent], projects: [leadProject], tasks: [], sessions: [] });
    await page.setViewportSize({ width, height: 844 });
    const line = page.getByRole("group", { name: "Project Lead", exact: true });
    await expect(line.getByRole("button", { name: "Discuss", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    const metrics = await line.evaluate((element) => {
      const box = (target: Element) => {
        const r = target.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const role = element.querySelector<HTMLElement>(".project-manager-line-role")!;
      return {
        line: box(element),
        text: box(element.querySelector(".project-manager-line-text")!),
        name: box(element.querySelector(".project-manager-line-name")!),
        role: box(role),
        roleClipped: role.scrollWidth > role.clientWidth + 1,
        buttons: [...element.querySelectorAll("button")].map(box),
      };
    });
    // The name keeps the row; the role line is read in full.
    expect(metrics.text.width).toBeGreaterThan(width / 2);
    expect(metrics.roleClipped, "role line is truncated").toBe(false);
    // The role sits right under the name; the 44px link floor once opened a
    // whole line between them.
    expect(metrics.role.top - metrics.name.bottom, "gap between name and role").toBeLessThanOrEqual(4);
    expect(metrics.name.height).toBeGreaterThanOrEqual(24);
    expect(metrics.buttons).toHaveLength(3);
    for (const button of metrics.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(metrics.line.left - 1);
      expect(button.right).toBeLessThanOrEqual(metrics.line.right + 1);
      expect(button.top, "controls share the name's row").toBeGreaterThanOrEqual(metrics.text.bottom - 1);
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.width).toBeGreaterThanOrEqual(44);
    }
    // The topics rise from the bottom edge, full width, with touch-height rows.
    await line.getByRole("button", { name: "Start with a topic", exact: true }).click();
    const items = page.getByRole("menuitem");
    await expect(items).toHaveCount(4);
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
    // WebKit can register the opening animation after getAnimations() was
    // sampled. Wait for the actual sheet position before measuring its rows.
    await expect.poll(async () => {
      const box = await page.locator('[data-slot="dropdown-menu-content"]').boundingBox();
      return box ? Math.round(box.y + box.height) : null;
    }).toBe(844);
    const sheet = await page.locator('[data-slot="dropdown-menu-content"]').boundingBox();
    expect(Math.round(sheet!.width)).toBe(width);
    expect(Math.round(sheet!.y + sheet!.height)).toBe(844);
    for (const item of await items.all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-lead-${width}.png` });
    await page.context().close();
  });
}
