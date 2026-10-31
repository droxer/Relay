import { expect, test, type Page } from "@playwright/test";

/* Loading and rendering budgets, measured against the production export.

   Every assertion here is about work the user never sees: rows that re-render
   on identical polls, DOM for threads nobody scrolled to, and parsers shipped
   to a page that never renders markdown. None of it shows in a screenshot,
   which is why it needs a test rather than a review. */

const USER_ID = "perf-user";
const T0 = Date.parse("2026-09-17T09:00:00Z");
const hoursAgo = (hours: number) => new Date(T0 - hours * 3_600_000).toISOString();
const USER = { id: USER_ID, userId: USER_ID, username: "perf", role: "user", theme: "light", language: "en" };

function session(id: string, index: number, turns = 0) {
  const events: unknown[] = [];
  const agentRuns: unknown[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const runId = `${id}-run-${turn}`;
    agentRuns.push({ id: runId, agent: "claude", status: "completed", mode: "action", startedAt: hoursAgo(2), completedAt: hoursAgo(2) });
    if (turn > 0) events.push({ id: `${runId}-user`, type: "user.message", sessionId: id, timestamp: hoursAgo(2), text: `Follow-up ${turn}`, actorUserId: USER_ID });
    events.push({ id: `${runId}-start`, type: "agent.started", sessionId: id, timestamp: hoursAgo(2), runId, agent: "claude", mode: "action" });
    const text = `Turn ${turn} changed \`verify${turn}.ts\`.\n\n\`\`\`ts\nexport const turn${turn} = ${turn};\n\`\`\``;
    events.push({ id: `${runId}-out`, type: "agent.output", sessionId: id, timestamp: hoursAgo(2), runId, agent: "claude", stream: "stdout",
      text: `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n` });
    events.push({ id: `${runId}-done`, type: "agent.completed", sessionId: id, timestamp: hoursAgo(2), runId, agent: "claude", status: "completed" });
  }
  return {
    id, title: `Thread number ${index}`, taskGoal: `Thread number ${index}`, status: ["completed", "failed"][index % 2],
    ownerUserId: USER_ID, workspacePath: "/w", phase: "created", participants: ["human"],
    createdAt: hoursAgo(index + 10), updatedAt: hoursAgo(index + 1),
    events, agentRuns, artifacts: [], decisions: [], collaborationRounds: [],
    eventCount: events.length, runCount: agentRuns.length, artifactCount: 0,
  };
}

const THREADS = Array.from({ length: 400 }, (_, index) => session(`s-${index}`, index));
const LONG_THREAD = session("s-0", 0, 150);

for (const width of [1280, 390]) {
  test(`OpenCode text streams into one Markdown block before completion (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.addInitScript(() => {
      class Source {
        static CLOSED = 2;
        readyState = 1;
        onmessage?: (event: { data: string }) => void;
        onopen?: () => void;
        constructor() {
          Object.assign(window, { __openCodeSource: this });
          queueMicrotask(() => this.onopen?.());
        }
        addEventListener() {}
        close() {}
      }
      Object.assign(window, { EventSource: Source });
    });
    const thread = { ...session("opencode", 0), status: "running", phase: "running" };
    const base = { sessionId: thread.id, runId: "run-opencode", agent: "opencode", timestamp: hoursAgo(0) };
    thread.events.push({ ...base, id: "start", type: "agent.started" });
    thread.agentRuns.push({ id: base.runId, agent: "opencode", status: "running", startedAt: base.timestamp, artifactIds: [] });
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = path.endsWith("/auth/me") ? { authenticated: true, user: USER }
        : path.endsWith("/threads/opencode") ? thread
          : { sessions: [thread], agents: [], teams: [], tasks: [], nodes: [], projects: [], sandboxes: [], skills: [] };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/threads/opencode");
    await expect(page.locator(".agent-stream-activity")).toBeVisible();
    const emit = async (event: unknown) => page.evaluate((value) => {
      const source = (window as unknown as { __openCodeSource: { onmessage: (event: { data: string }) => void } }).__openCodeSource;
      source.onmessage({ data: JSON.stringify(value) });
    }, event);
    let index = 0;
    const chunk = async (text: string) => emit({
      ...base, id: `output-${++index}`, type: "agent.output", stream: "stdout",
      text: `${JSON.stringify({ type: "text", delta: true, part: { type: "text", text } })}\n`,
    });
    await chunk("Reviewing");
    await expect(page.locator(".agent-stream .agent-prose")).toHaveText("Reviewing");
    await chunk(" the ");
    await chunk("**streaming** output.\n\n```ts\n");
    await chunk("  const ready = true;\n```");
    const prose = page.locator(".agent-stream .agent-prose");
    await expect(prose).toHaveCount(1);
    await expect(prose.locator("strong")).toHaveText("streaming");
    await expect(prose.locator("code")).toContainText("const ready = true;");
    await expect(page.locator(".agent-text.is-live")).toHaveCount(1);
    expect(await page.locator("body").evaluate((el) => el.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/tmp/relay-opencode-stream-${width}.png` });
    await emit({ ...base, id: "complete", type: "agent.completed", status: "completed", exitCode: 0 });
    await expect(page.locator(".agent-text.is-live")).toHaveCount(0);
    await expect(prose.locator("p")).toHaveText("Reviewing the streaming output.");
    await expect(prose.locator("code")).toContainText("const ready = true;");
  });
}

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: THREADS, agents: [], teams: [], tasks: [], nodes: [], projects: [], sandboxes: [], skills: [] };
    if (pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    else if (/\/threads\/s-\d+$/.test(pathname)) body = pathname.endsWith("/s-0") ? LONG_THREAD : THREADS.find((t) => pathname.endsWith(`/${t.id}`));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

/* Production React reports every commit to a DevTools hook when one exists.
   A host element whose props object was replaced in a commit belongs to a
   component that rendered — which is how a row re-render is counted without
   a profiling build. */
function installCommitCounter() {
  const counter = { commits: 0, rowRenders: 0 };
  (window as unknown as { __commits: typeof counter }).__commits = counter;
  let rendererId = 0;
  (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    checkDCE() {},
    inject() { return ++rendererId; },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      counter.commits++;
      const walk = (start: Fiber | null) => {
        for (let fiber = start; fiber; fiber = fiber.sibling) {
          const previous = fiber.alternate;
          if (typeof fiber.type === "string" && previous && fiber.memoizedProps !== previous.memoizedProps
            && /\bconversation-name\b/.test(String(fiber.memoizedProps?.className ?? ""))) counter.rowRenders++;
          walk(fiber.child);
        }
      };
      walk(root.current.child);
    },
  };
  type Fiber = { type: unknown; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; memoizedProps: { className?: unknown } | null };
}

test("identical polls do not re-render the app or the thread rail", async ({ page }) => {
  await page.addInitScript(installCommitCounter);
  await mockApi(page);
  await page.goto("/threads");
  await expect(page.locator(".conversation-name").first()).toBeVisible();
  // Let first-load commits settle, then watch 10s of identical polls: two
  // sessions polls (5s) plus a nodes and a tasks poll (10s) — see
  // RELAY_POLL_INTERVALS_MS. The sessions query shares unchanged records
  // across polls (shareSessions), so even the first refetch moves no row.
  await page.waitForTimeout(4_000);
  await page.evaluate(() => Object.assign((window as unknown as { __commits: object }).__commits, { commits: 0, rowRenders: 0 }));
  await page.waitForTimeout(10_000);
  const { commits, rowRenders } = await page.evaluate(() => (window as unknown as { __commits: { commits: number; rowRenders: number } }).__commits);
  expect({ commits, rowRenders }, "thread rows re-rendered on unchanged data").toMatchObject({ rowRenders: 0 });
  // Before: ~18 app-wide commits in 10s, one per fetch start and end.
  expect(commits, "app-wide commits while idle").toBeLessThanOrEqual(2);
});

test("the thread rail mounts a bounded window and grows as it scrolls", async ({ page }) => {
  await mockApi(page);
  await page.goto("/threads");
  const rows = page.locator(".thread-panel .conversation-name");
  await expect(rows.first()).toBeVisible();
  const initial = await rows.count();
  expect(initial, "rows mounted for 400 threads").toBeLessThanOrEqual(100);

  const list = page.locator(".thread-panel .conversation-list");
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => rows.count()).toBeGreaterThan(initial);
});

test("a selected thread deep in the rail is mounted and can load the remaining threads", async ({ page }) => {
  await mockApi(page);
  await page.goto("/threads/s-350");
  await expect(page.locator('.thread-panel [aria-current="page"]')).toContainText("Thread number 350");
  await page.locator(".thread-panel .conversation-list").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator(".thread-panel .conversation-name")).toHaveCount(THREADS.length);
});

test("a long transcript mounts its newest turns and reveals older ones on scroll", async ({ page }) => {
  await mockApi(page);
  await page.goto("/threads/s-0");
  const turns = page.locator(".transcript-turn");
  await expect(page.locator(".agent-code").last()).toContainText("turn149");
  const initial = await turns.count();
  expect(initial, "turns mounted for a 150-turn thread").toBeLessThanOrEqual(60);

  // Reaching the top loads the next page without jumping the reader.
  const transcript = page.locator(".transcript");
  // .transcript-turn is display:contents, so measure the block it wraps.
  // textContent, not innerText: an off-screen turn is content-visibility skipped.
  const oldestTurn = Number((await page.locator(".agent-code").first().textContent())!.match(/turn(\d+)/)![1]);
  await transcript.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => turns.count()).toBeGreaterThan(initial);
  const offset = await page.locator(".agent-code", { hasText: new RegExp(`\\bturn${oldestTurn} = `) }).evaluate((element) => {
    const frame = element.closest(".transcript")!.getBoundingClientRect();
    return element.getBoundingClientRect().top - frame.top;
  });
  // It was at the top edge when the page landed; it must not have been
  // shoved a page down (or up) by the turns mounted above it.
  expect(Math.abs(offset), "the turn the reader was looking at stays in view").toBeLessThan(400);
});

test("the eager bundle ships no markdown pipeline, syntax grammars or unused locales", async ({ page, request }) => {
  const html = await (await request.get("/")).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"(?![^>]*noModule)/gi)].map((match) => match[1]);
  expect(scripts.length).toBeGreaterThan(0);
  const eager = (await Promise.all(scripts.map(async (src) => (await request.get(src)).text()))).join("\n");
  const leaked = Object.entries({
    KaTeX: "KaTeX parse error",
    "highlight.js": "highlightAuto",
    remark: "micromark",
    "zh-CN catalogue": "每位用户的进行中任务上限",
    // The app's English rides the app chunk; only the public subset
    // (landing, sign-in, waitlist, password reset) is eager.
    "app English catalogue": "Manage users, computers, and organization settings.",
    "artifact viewer": "artifact-viewer-body",
  }).filter(([, signature]) => eager.includes(signature)).map(([name]) => name);
  expect(leaked, "modules found in the eager bundle").toEqual([]);

  // …and markdown still renders once a thread asks for it.
  await mockApi(page);
  await page.goto("/threads/s-0");
  await expect(page.locator(".agent-code").last()).toContainText("turn149");
});

test("a Chinese-language user still gets the lazily loaded catalogue", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname.endsWith("/auth/me")
      ? { authenticated: true, user: { ...USER, language: "zh-CN" } }
      : { sessions: [], agents: [], teams: [], tasks: [], nodes: [], projects: [], sandboxes: [], skills: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "没有未完成的任务" })).toBeVisible();
});
