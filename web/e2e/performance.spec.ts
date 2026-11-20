import { expect, test, type Page } from "@playwright/test";

/* Loading and rendering budgets, measured against the production export.

   Every assertion here is about work the user never sees: rows that re-render
   on identical polls, DOM for threads nobody scrolled to, and parsers shipped
   to a page that never renders markdown. None of it shows in a screenshot,
   which is why it needs a test rather than a review. */

const USER_ID = "perf-user";
const computer = { id: "perf-node", userId: USER_ID, online: true, stale: false, status: "ready", agents: { claude: "ready" }, activeRuns: [] };
const workPath = "/computers/node%3Aperf-node";
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
    ownerUserId: USER_ID, computerId: "node:perf-node", projectId: null, workspacePath: "/w", phase: "created", participants: ["human"],
    createdAt: hoursAgo(index + 10), updatedAt: hoursAgo(index + 1),
    events, agentRuns, artifacts: [], decisions: [], collaborationRounds: [],
    eventCount: events.length, runCount: agentRuns.length, artifactCount: 0,
  };
}

const THREADS = Array.from({ length: 400 }, (_, index) => session(`s-${index}`, index));
const LONG_THREAD = session("s-0", 0, 150);

test("the shared Agent roster omits configuration and opens only the selected record", async ({ page }) => {
  const stamp = hoursAgo(1);
  const base = { supervisorUserId: USER_ID, executorKind: "codex", defaultRole: "reviewer", enabled: true,
    availability: "offline", placements: [], modelPolicy: {}, skillPolicy: {}, toolPolicy: {}, createdAt: stamp, updatedAt: stamp, version: 1 };
  const other = { ...base, id: "helper", displayName: "Build helper" };
  let chosen = { ...base, id: "reviewer", displayName: "Release reviewer", instructions: "Inspect the quokka fixture before merging." };
  const summaryReads: string[] = [];
  const setupReads: string[] = [];
  const matches: string[] = [];
  const records: string[] = [];
  const writes: unknown[] = [];
  await page.route("**/api/**", async route => {
    const { pathname, searchParams } = new URL(route.request().url());
    let body: unknown = { user: USER, sessions: [], agents: [], teams: [], projects: [], nodes: [computer], homeTaskNeedsYou: 0 };
    if (pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    if (pathname.endsWith("/agents")) {
      if (searchParams.get("view") === "matches") {
        const query = searchParams.get("q") ?? "";
        matches.push(query);
        body = { agentIds: chosen.instructions.includes(query) ? [chosen.id] : [] };
      } else if (searchParams.get("view") === "setup") {
        setupReads.push(pathname);
        body = { view: "setup", defaultAgentOffers: [], onboardingAgents: [] };
      } else {
        summaryReads.push(searchParams.get("view") ?? "");
        const { instructions: _, ...summary } = chosen;
        body = { view: "summary", searchesInstructions: true, defaultAgentOffers: [], agents: [other, summary] };
      }
    } else if (pathname.endsWith(`/agents/${chosen.id}`)) {
      if (route.request().method() === "PATCH") {
        const change = route.request().postDataJSON();
        writes.push(change);
        chosen = { ...chosen, ...change, version: chosen.version + 1 };
      } else records.push(chosen.id);
      body = { agent: chosen };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/settings/language");
  await expect.poll(() => setupReads).toEqual(["/api/v1/agents"]);
  expect(summaryReads).toEqual([]);
  expect(records).toEqual([]);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  const roster = page.locator(".agents-roster-list");
  await expect(roster.getByRole("button", { name: /Build helper/ })).toBeVisible();
  expect(summaryReads).toEqual(["summary"]);
  await page.getByRole("searchbox", { name: "Search agents" }).fill("quokka fixture");
  await expect(roster.getByRole("button", { name: /Release reviewer/ })).toBeVisible();
  await expect(roster.getByRole("button", { name: /Build helper/ })).toHaveCount(0);
  expect(matches).toEqual(["quokka fixture"]);
  expect(records).toEqual([]);

  await roster.getByRole("button", { name: /Release reviewer/ }).click();
  const detail = page.locator("#agent-detail-panel");
  await expect(detail.getByText(chosen.instructions, { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Edit profile", exact: true }).click();
  await expect(detail.locator('textarea[name="agent-personality"]')).toHaveValue(chosen.instructions);
  await detail.locator('input[name="agent-profile-name"]').fill("Release auditor");
  await detail.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(detail.getByRole("heading", { name: "Release auditor", exact: true })).toBeVisible();
  expect(writes).toEqual([{ displayName: "Release auditor" }]);
  expect(records).toEqual([chosen.id]);
});

test("the admin roster only loads one user page and its Computer labels", async ({ page }) => {
  const admin = { ...USER, role: "admin" };
  const users = Array.from({ length: 29 }, (_, index) => ({
    id: `user-${index}`, displayName: `Roster member ${index}`, handle: `member-${index}`,
  }));
  const target = users[28];
  const node = { ...computer, userId: target.id, displayName: "Workshop workstation" };
  const requests: string[][] = [];
  const workspaceDirectories: string[] = [];
  let fleetReads = 0;
  await page.route("**/api/**", async route => {
    const { pathname, searchParams } = new URL(route.request().url());
    let body: unknown = {
      agents: [], teams: [], tasks: [], nodes: [], projects: [], sessions: [],
      homeTaskNeedsYou: 0, settings: {},
    };
    if (pathname.endsWith("/auth/me")) body = { authenticated: true, user: admin };
    if (pathname === "/api/v1/agents" && searchParams.get("view") === "setup") {
      body = { view: "setup", onboardingAgents: [], defaultAgentOffers: [] };
    } else if (/^\/api\/v1\/(agents|teams|projects)$/.test(pathname)) {
      workspaceDirectories.push(pathname);
    }
    if (pathname.endsWith("/admin/daemon-nodes")) fleetReads += 1;
    if (pathname.endsWith("/admin/users")) {
      requests.push(["view", "page", "q"].map(key => searchParams.get(key) ?? ""));
      const query = searchParams.get("q");
      const pageNumber = Number(searchParams.get("page") ?? 1);
      const matches = query ? [target] : users;
      const visible = matches.slice((pageNumber - 1) * 25, pageNumber * 25);
      body = {
        users: visible,
        nodes: visible.includes(target) ? [node] : [],
        page: { page: pageNumber, total: matches.length },
        counts: { all: 29, running: 0, ready: 1, failed: 0, idle: 0, unassigned: 28 },
        displayOrder: visible.map(user => user.id), userCount: 29,
      };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/admin/users");
  await expect(page.locator(".adm-emp-card")).toHaveCount(25);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.locator(".adm-emp-card")).toHaveCount(4);
  const result = page.waitForResponse(response => new URL(response.url()).searchParams.get("q") === node.displayName);
  await page.locator('input[name="admin-users-search"]').fill(node.displayName);
  await result;
  await expect(page.locator(".adm-emp-card")).toHaveCount(1);
  await expect(page.getByText(node.displayName, { exact: true })).toBeVisible();
  expect(requests).toEqual([["web", "1", ""], ["web", "2", ""], ["web", "1", node.displayName]]);
  expect(fleetReads).toBe(0);
  expect(workspaceDirectories).toEqual([]);
});

test("global Issues requests one filtered window at a time", async ({ page }) => {
  const requests: { layout: string | null; page: string | null; query: string | null; lanes: string | null }[] = [];
  const tasks = Array.from({ length: 54 }, (_, index) => ({
    id: `issue-${index + 1}`, number: index + 1, title: `Queue item ${index + 1}`,
    status: "backlog", priority: "normal", description: "", isRoutine: false, linkedSessionIds: [],
    createdAt: hoursAgo(1), updatedAt: hoursAgo(1), ownerUserId: USER_ID,
  }));
  await page.route("**/api/**", async (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    let body: unknown = {
      agents: [], teams: [], tasks: [], nodes: [computer], projects: [],
      sessions: [], homeTaskNeedsYou: 0, user: USER,
    };
    if (pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    if (pathname.endsWith("/tasks")) {
      const layout = searchParams.get("layout");
      const requestedPage = searchParams.get("page");
      const query = searchParams.get("q");
      const lanes = searchParams.get("lanes");
      requests.push({ layout, page: requestedPage, query, lanes });
      const actualPage = Number(requestedPage ?? 1);
      const matches = query ? tasks.filter((task) => task.title.includes(query)) : tasks;
      const lanePage = Number(lanes?.split(":")[1] ?? 1);
      body = {
        ...(layout === "board" ? {
          tasks: matches.slice((lanePage - 1) * 10, lanePage * 10),
          lanes: Object.fromEntries(["backlog", "assigned", "queued", "running", "review", "done", "cancelled"]
            .map(lane => [lane, lane === "backlog" ? { page: lanePage, total: matches.length } : { page: 1, total: 0 }])),
        } : {
          tasks: matches.slice((actualPage - 1) * 50, actualPage * 50),
          page: { page: actualPage, total: matches.length },
        }),
        issueCount: tasks.length,
        counts: { needs_me: 0, untriaged: matches.length, blocked: 0, running: 0, overdue: 0, open: matches.length, done: 0, cancelled: 0 },
        groupTotals: { none: matches.length }, tags: [],
      };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/issues");
  await expect(page.getByText("Queue item 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Queue item 54", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Queue item 54", { exact: true })).toBeVisible();
  const results = page.waitForResponse(response => new URL(response.url()).searchParams.get("q") === "Queue item 2");
  await page.locator('input[name="backlog-query"]').fill("Queue item 2");
  await results;
  await expect(page.getByText("Queue item 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
  await expect(page.getByText("Queue item 29", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Queue item 29", { exact: true })).toBeVisible();
  expect(requests).toEqual([
    { layout: "list", page: null, query: null, lanes: null },
    { layout: "list", page: "2", query: null, lanes: null },
    { layout: "list", page: null, query: "Queue item 2", lanes: null },
    { layout: "board", page: null, query: "Queue item 2", lanes: null },
    { layout: "board", page: null, query: "Queue item 2", lanes: "backlog:2" },
  ]);
});

for (const isProject of [true, false]) {
  test(`${isProject ? "Project" : "Computer"} Tasks only requests its visible window and the exact record`, async ({ page }) => {
    const project = { id: "perf-project", name: "Sample project", computerId: "node:perf-node", ownerUserId: USER_ID, enabled: true, members: [],
      workspaceLayout: "project", version: 1, createdAt: hoursAgo(2), updatedAt: hoursAgo(1) };
    const params = isProject ? { projectId: project.id } : { computerId: "node:perf-node" };
    const tasks = Array.from({ length: 28 }, (_, index) => ({
      id: `workspace-task-${index + 1}`, title: `Workspace work ${index + 1}`, ...params,
      ownerUserId: USER_ID, status: "backlog", priority: "normal", isRoutine: false, linkedSessionIds: [],
      description: "", createdAt: hoursAgo(2), updatedAt: hoursAgo(1),
    }));
    const target = tasks.at(-1)!;
    const reads: string[][] = [];
    const details: string[] = [];
    const choices: string[][] = [];
    await page.route("**/api/**", async route => {
      const { pathname, searchParams } = new URL(route.request().url());
      let body: unknown = { agents: [], teams: [], tasks: [], nodes: [computer], projects: [project], sessions: [], homeTaskNeedsYou: 0 };
      if (pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
      if (pathname.endsWith("/tasks") && searchParams.get("view") === "prerequisite-choices") {
        choices.push(["taskId", "q", "page"].map(key => searchParams.get(key) ?? ""));
        const candidates = searchParams.has("q") ? [tasks[26]] : tasks.slice(0, 25);
        body = { tasks: candidates, page: { page: 1, total: searchParams.has("q") ? 1 : 27 } };
      } else if (pathname.endsWith("/tasks")) {
        reads.push(["scope", "layout", "projectId", "computerId", "page", "q"].map(key => searchParams.get(key) ?? ""));
        const items = searchParams.has("q") ? [target] : tasks;
        const position = Number(searchParams.get("page") ?? 1);
        body = { tasks: items.slice((position - 1) * 25, position * 25), issueCount: tasks.length,
          page: { page: position, total: items.length }, tags: [] };
      } else if (pathname.endsWith(`/tasks/${target.id}`)) {
        details.push(searchParams.get("view") ?? "");
        body = { ...target, description: "Full description loaded for this task only" };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(isProject ? `/projects/${project.id}?tab=tasks` : `${workPath}/tasks`);
    const rows = page.locator(".backlog-rows");
    await expect(rows.getByRole("link", { name: "Workspace work 1", exact: true })).toBeVisible();
    const record = rows.getByRole("link", { name: target.title, exact: true });
    await expect(record).toHaveCount(0);
    await rows.getByRole("button", { name: "Next page" }).click();
    await expect(record).toBeVisible();
    await page.locator('input[name="backlog-query"]').fill("needle in the description");
    await expect(rows.getByRole("link", { name: /Workspace work/ })).toHaveCount(1);
    await record.click();
    await expect(page.getByRole("dialog")).toContainText("Full description loaded for this task only");
    const scope = isProject ? [project.id, ""] : ["", "node:perf-node"];
    expect(reads).toEqual([
      ["board", "list", ...scope, "", ""],
      ["board", "list", ...scope, "2", ""],
      ["board", "list", ...scope, "", "needle in the description"],
    ]);
    expect(details).toEqual(["record"]);
    expect(choices).toEqual([]);
    if (isProject) {
      await page.getByRole("button", { name: "Add prerequisite", exact: true }).click();
      await expect(page.getByRole("button", { name: /Workspace work 1$/ })).toBeVisible();
      await page.getByRole("searchbox", { name: "Search tasks" }).fill("Workspace work 27");
      await expect(page.getByRole("button", { name: /Workspace work 27$/ })).toBeVisible();
      expect(choices).toEqual([[target.id, "", ""], [target.id, "Workspace work 27", ""]]);
    }
  });
}

for (const scope of ["global", "project", "computer"] as const) {
  test(`${scope} Automations pages definitions without loading occurrences`, async ({ page }) => {
    const project = { id: "perf-project", name: "Sample project", computerId: "node:perf-node", ownerUserId: USER_ID, enabled: true,
      members: [], workspaceLayout: "project", version: 1, createdAt: hoursAgo(2), updatedAt: hoursAgo(1) };
    const placement = scope === "project" ? { projectId: project.id } : scope === "computer" ? { computerId: "node:perf-node" } : {};
    const tasks = Array.from({ length: 29 }, (_, index) => ({
      id: `definition-${index + 1}`, title: `Automation work ${index + 1}`, ...placement,
      description: "", ownerUserId: USER_ID, status: "backlog", priority: "normal", isRoutine: true,
      routineState: "paused", routineTriggers: [], linkedSessionIds: [], eventCount: 2, createdAt: hoursAgo(2), updatedAt: hoursAgo(1),
    }));
    const target = tasks.at(-1)!;
    const runId = "historical-run";
    const reads: string[][] = [];
    const details: string[] = [];
    await page.route("**/api/**", async route => {
      const { pathname, searchParams } = new URL(route.request().url());
      let body: unknown = { agents: [], teams: [], tasks: [], nodes: [computer], projects: [project], sessions: [], runs: [], homeTaskNeedsYou: 0 };
      if (pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
      if (pathname.endsWith("/tasks")) {
        reads.push(["scope", "layout", "projectId", "computerId", "page", "q"].map(key => searchParams.get(key) ?? ""));
        const items = searchParams.has("q") ? [target] : tasks;
        const position = Number(searchParams.get("page") ?? 1);
        body = { tasks: items.slice((position - 1) * 25, position * 25), automationCount: tasks.length,
          page: { page: position, total: items.length }, tags: [],
          counts: { running: 0, scheduled: 0, due: 0, listening: 0, on_demand: 0, paused: items.length },
          states: {}, hasLiveRuns: false };
      } else if (pathname.endsWith(`/tasks/${runId}`)) {
        details.push(runId);
        body = { ...target, id: runId, title: "Old occurrence", description: "Archived run instructions", isRoutine: false, status: "done",
          sourceRoutineId: target.id, routineParent: { id: target.id, title: target.title }, scheduledFor: "2026-09-17T00:00:00Z" };
      } else if (pathname.endsWith(`/tasks/${target.id}`)) {
        details.push(target.id);
        body = { ...target, description: "Full automation instructions" };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    const projectUrl = `/projects/${project.id}?tab=automations`;
    const listUrl = scope === "project" ? projectUrl : scope === "computer" ? `${workPath}/automations` : "/automations";
    await page.goto(listUrl);
    const rows = page.locator(".backlog-rows");
    await expect(rows.getByRole("link", { name: "Automation work 1", exact: true })).toBeVisible();
    const record = rows.getByRole("link", { name: target.title, exact: true });
    await expect(record).toHaveCount(0);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(record).toBeVisible();
    await page.locator('input[name="routine-query"]').fill("needle in instructions");
    await expect(rows.getByRole("link", { name: /Automation work/ })).toHaveCount(1);
    if (scope === "computer") {
      await rows.getByRole("button", { name: "Assign agent or team", exact: true }).click();
      await expect(page.locator('textarea[name="routine-description"]')).toHaveValue("Full automation instructions");
      await page.getByRole("button", { name: "Close drawer", exact: true }).click();
    }
    await record.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => details).toEqual([target.id]);
    const expectedScope = scope === "project" ? [project.id, ""] : scope === "computer" ? ["", "node:perf-node"] : ["", ""];
    expect(reads).toEqual([
      ["automations", "list", ...expectedScope, "", ""],
      ["automations", "list", ...expectedScope, "2", ""],
      ["automations", "list", ...expectedScope, "", "needle in instructions"],
    ]);

    reads.length = 0;
    details.length = 0;
    const runUrl = scope === "project" ? `${projectUrl}&automation=${target.id}&run=${runId}` : `${listUrl}/${target.id}/runs/${runId}`;
    await page.goto(runUrl);
    await expect(page.getByRole("dialog").getByRole("link", { name: target.title, exact: true })).toBeVisible();
    await expect(rows.getByRole("link", { name: "Automation work 1", exact: true })).toBeVisible();
    expect(reads).toEqual([["automations", "list", ...expectedScope, "", ""]]);
    expect(details).toEqual([runId]);
  });
}

test("a mobile deep link keeps the composer docked while summary and detail arrive", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const thread = session("mobile-load", 0, 3);
  let releaseList!: () => void;
  let releaseDetail!: () => void;
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  const detailGate = new Promise<void>((resolve) => { releaseDetail = resolve; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { agents: [], teams: [], tasks: [], nodes: [computer], projects: [], sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    else if (path.endsWith(`/threads/${thread.id}`)) {
      await detailGate;
      body = thread;
    } else if (path.endsWith("/threads")) {
      await listGate;
      body = { sessions: [{ ...thread, events: [], agentRuns: [] }] };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  try {
    await page.goto(`${workPath}/threads/${thread.id}`);
    const composer = page.locator("form.composer");
    await expect(composer).toBeVisible();
    const top = await composer.evaluate((element) => element.getBoundingClientRect().top);
    await expect(page.locator(".chat-panel--landing")).toHaveCount(0);
    const loading = page.getByRole("log").getByRole("status").filter({ hasText: "Loading conversation…" });
    await expect(loading).toBeVisible();
    releaseList();
    await expect(page.locator(".mobile-topbar")).toContainText(thread.title);
    // A summary has a goal but no turns. Painting it now would insert a
    // temporary opening message that the full transcript then displaces.
    await expect(page.locator(".transcript .msg")).toHaveCount(0);
    await expect(loading).toBeVisible();
    expect(await composer.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(top, 0);
    releaseDetail();
    await expect(page.locator(".agent-code").last()).toContainText("turn2");
    await expect(loading).toHaveCount(0);
    expect(await composer.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(top, 0);
  } finally {
    releaseList();
    releaseDetail();
  }
});

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
          : { sessions: [thread], agents: [], teams: [], tasks: [], nodes: [computer], projects: [], sandboxes: [], skills: [] };
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
    let body: unknown = { sessions: THREADS, agents: [], teams: [], tasks: [], nodes: [computer], projects: [], sandboxes: [], skills: [] };
    if (pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    else if (/\/threads\/s-\d+$/.test(pathname)) body = pathname.endsWith("/s-0") ? LONG_THREAD : THREADS.find((t) => pathname.endsWith(`/${t.id}`));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

/* Production React reports every commit to a DevTools hook when one exists.
   A host element whose props object was replaced in a commit belongs to a
   component that rendered — which is how a row re-render is counted without
   a profiling build. A memoized component that bails out does not clone its
   children: the committed fiber keeps the very child its alternate has, and
   those children's alternates still hold props from an older render. So a
   subtree whose child pointer did not move was not touched by this commit
   and is skipped, as React DevTools does; otherwise a row that re-rendered
   once for a real reason reads as rendering again on every later commit. */
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
          if (previous && previous.child === fiber.child) continue;
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
  let revalidations = 0;
  let taskListReads = 0;
  await page.route("**/api/v1/tasks?*", async route => {
    taskListReads++;
    await route.fulfill({ json: { tasks: [] } });
  });
  const etag = 'W/"thread-list"';
  await page.route("**/api/v1/threads?*", async (route) => {
    if (route.request().headers()["if-none-match"] === etag) {
      revalidations++;
      await route.fulfill({ status: 304, headers: { ETag: etag } });
      return;
    }
    await route.fulfill({ json: {
      sessions: THREADS.map((session, index) => ({
        ...session, ...(index === 0 ? { status: "running" } : {}), taskActivity: {
          origin: index === 0 ? { kind: "backlog", taskId: "linked-task", ref: "#41", title: "Linked issue", status: "waiting_for_human" } : null,
          awaitsHuman: index === 0,
        },
      })),
      homeTaskNeedsYou: 2,
    }, headers: { ETag: etag } });
  });
  await page.goto(`${workPath}/threads`);
  await expect(page.locator(".conversation-name").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Home, 2 items need attention" })).toBeVisible();
  await expect(page.getByText("#41", { exact: true })).toBeVisible();
  // Let first-load commits settle, then watch 10s of identical polls: two
  // sessions polls (5s) plus a nodes poll (10s) — see
  // RELAY_POLL_INTERVALS_MS. The sessions query shares unchanged records
  // across polls (shareSessions), so even the first refetch moves no row.
  await page.waitForTimeout(4_000);
  await page.evaluate(() => Object.assign((window as unknown as { __commits: object }).__commits, { commits: 0, rowRenders: 0 }));
  await page.waitForTimeout(10_000);
  const { commits, rowRenders } = await page.evaluate(() => (window as unknown as { __commits: { commits: number; rowRenders: number } }).__commits);
  expect({ commits, rowRenders }, "thread rows re-rendered on unchanged data").toMatchObject({ rowRenders: 0 });
  expect(revalidations).toBeGreaterThan(0);
  expect(taskListReads).toBe(0);
  // Before: ~18 app-wide commits in 10s, one per fetch start and end.
  expect(commits, "app-wide commits while idle").toBeLessThanOrEqual(2);
  await page.locator(".thread-kind-filter").getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator(".conversation-name")).toHaveCount(1);
  await expect(page.getByText("#41", { exact: true })).toBeVisible();
  expect(taskListReads).toBe(0);
  await page.getByRole("link", { name: "Home, 2 items need attention" }).click();
  await expect.poll(() => taskListReads).toBe(1);
});

test("the thread rail mounts a bounded window and grows as it scrolls", async ({ page }) => {
  await mockApi(page);
  await page.goto(`${workPath}/threads`);
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
  await expect(page.locator('.thread-panel .conversation-row [aria-current="page"]')).toContainText("Thread number 350");
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

test("a cold conversation opens on its latest window and requests older messages on demand", async ({ page }) => {
  const thread = session("paged-history", 0, 2);
  const eventStart = 3;
  let historyReads = 0;
  let queueReads = 0;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown = { sessions: [thread], agents: [], teams: [], tasks: [], nodes: [computer], projects: [], sandboxes: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    else if (path.endsWith("/threads/paged-history/queue")) {
      queueReads++;
      body = { messages: [], paused: false };
    } else if (path.endsWith("/threads/paged-history")) {
      expect(url.searchParams.get("view")).toBe("transcript");
      if (url.searchParams.get("before")) {
        historyReads++;
        expect(url.searchParams.get("before")).toBe(String(eventStart));
        if (historyReads === 1) {
          await route.fulfill({ status: 503, json: { detail: "Try again" } });
          return;
        }
        body = { eventStart: 0, eventCount: eventStart, events: thread.events.slice(0, eventStart) };
      } else {
        body = {
          ...thread, eventStart, eventOffset: eventStart, eventsRevision: "a".repeat(64),
          events: thread.events.slice(eventStart), messageQueue: { messages: [], paused: false },
        };
      }
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/threads/paged-history");
  const output = page.locator(".agent-code");
  await expect(output).toHaveCount(1);
  await expect(output.first()).toContainText("turn1");
  const older = page.getByRole("button", { name: "Load earlier messages" });
  await expect(older).toBeVisible();
  expect({ historyReads, queueReads }).toEqual({ historyReads: 0, queueReads: 0 });
  await older.click();
  await expect(page.locator(".transcript-history [role=alert]")).toBeVisible();
  await older.click();
  await expect(output).toHaveCount(2);
  await expect(output.first()).toContainText("turn0");
  await expect(output.last()).toContainText("turn1");
  await expect(older).toHaveCount(0);
  expect(historyReads).toBe(2);
});

test("a conversation skips file-only history pages until its first messages are visible", async ({ page }) => {
  const original = session("file-only-history", 0, 1);
  const fileEvents = Array.from({ length: 3 }, (_, index) => {
    const id = `file-${index}`;
    return {
      id, type: "artifact.created", sessionId: original.id, timestamp: hoursAgo(1),
      artifact: { id, kind: "workspace_file", title: id, path: `/w/${id}`, createdAt: hoursAgo(1),
        agentRunId: `${original.id}-run-0` },
    };
  });
  const events = [...original.events, ...fileEvents];
  const thread = { ...original, events, eventCount: events.length, artifacts: fileEvents.map(event => event.artifact) };
  const historyReads: number[] = [];
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    let body: unknown = { sessions: [thread], agents: [], teams: [], tasks: [], nodes: [computer], projects: [], sandboxes: [] };
    if (url.pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    else if (url.pathname.endsWith(`/threads/${thread.id}`)) {
      expect(url.searchParams.get("view")).toBe("transcript");
      const before = url.searchParams.get("before");
      if (before) {
        const eventCount = Number(before);
        historyReads.push(eventCount);
        const eventStart = eventCount === 5 ? 3 : 0;
        body = { eventStart, eventCount, events: events.slice(eventStart, eventCount) };
      } else {
        body = { ...thread, eventStart: 5, eventOffset: 5, eventsRevision: "c".repeat(64), events: events.slice(5) };
      }
    }
    await route.fulfill({ json: body });
  });
  await page.goto(`/threads/${thread.id}`);
  await expect(page.locator(".transcript .agent-code")).toContainText("turn0");
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
  expect(historyReads).toEqual([5, 3]);
});

test("scrolling toward older messages fetches one history page without moving the reading position", async ({ page }) => {
  const original = session("scroll-history", 0, 15);
  const review = { id: "review", kind: "review", title: "Generated review", path: "/w/review.md", createdAt: hoursAgo(1) };
  const thread = {
    ...original, artifacts: [review], artifactCount: 1, eventCount: original.eventCount + 1,
    events: [...original.events, {
      id: "review-created", type: "artifact.created", sessionId: original.id, timestamp: review.createdAt, artifact: review,
    }],
  };
  const eventStart = 27;
  let historyReads = 0;
  let artifactReads = 0;
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/threads/scroll-history/artifacts/review")) {
      artifactReads++;
      await route.fulfill({ contentType: "text/plain", body: "Generated review body" });
      return;
    }
    let body: unknown = { sessions: [thread], agents: [], teams: [], tasks: [], nodes: [computer], projects: [], sandboxes: [] };
    if (url.pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    else if (url.pathname.endsWith("/threads/scroll-history")) {
      if (url.searchParams.has("before")) {
        historyReads++;
        expect(url.searchParams.get("before")).toBe(String(eventStart));
        await historyGate;
        body = { eventStart: 0, eventCount: eventStart, events: thread.events.slice(0, eventStart) };
      } else {
        body = { ...thread, eventStart, eventOffset: eventStart, eventsRevision: "b".repeat(64), events: thread.events.slice(eventStart) };
      }
    }
    await route.fulfill({ json: body });
  });
  try {
    await page.goto("/threads/scroll-history");
    const transcript = page.locator(".transcript");
    const output = transcript.locator(".agent-code");
    await expect(output).toHaveCount(8);
    await expect.poll(() => transcript.evaluate(element => element.scrollTop)).toBeGreaterThan(600);
    expect(historyReads).toBe(0);
    expect(artifactReads).toBe(0);

    await transcript.evaluate(element => { element.scrollTop = 120; });
    await expect.poll(() => historyReads).toBe(1);
    await transcript.evaluate(element => { element.scrollTop = 0; });
    const turn = output.filter({ hasText: /\bturn7 =/ });
    const offset = () => turn.evaluate(element =>
      element.getBoundingClientRect().top - element.closest(".transcript")!.getBoundingClientRect().top);
    const before = await offset();
    releaseHistory();
    await expect(output).toHaveCount(15);
    await expect(output.first()).toContainText("turn0");
    await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThan(400);
    expect(historyReads).toBe(1);
    expect(artifactReads).toBe(0);
    await page.getByRole("button", { name: /view generated review/i }).click();
    await expect(page.getByText("Generated review body")).toBeVisible();
    expect(artifactReads).toBe(1);
  } finally {
    releaseHistory();
  }
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
      : { sessions: [], agents: [], teams: [], tasks: [], nodes: [computer], projects: [], sandboxes: [], skills: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`${workPath}/tasks`);
  await expect(page.getByRole("heading", { name: "暂无任务" })).toBeVisible();
});

test("a deep link outside the first page loads only its requested transcript", async ({ page }) => {
  const older = session("outside-head", 99, 2);
  const details: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: THREADS.slice(0, 20), nextCursor: "older-page", agents: [], teams: [], tasks: [], nodes: [computer], projects: [], sandboxes: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: USER };
    else if (/\/threads\/[^/]+$/.test(path)) {
      details.push(path);
      await gate;
      body = older;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  try {
    await page.goto("/threads/outside-head");
    await expect.poll(() => details.length).toBe(1);
    await expect(page.locator(".transcript .msg")).toHaveCount(0);
    release();
    await expect(page.locator(".agent-code").last()).toContainText("turn1");
    await page.waitForLoadState("networkidle");
    expect(details).toEqual(["/api/v1/threads/outside-head"]);
    await expect(page).toHaveURL(/\/threads\/outside-head$/);
  } finally { release(); }
});

test("settings loads onboarding and defers workspace directories and transcripts", async ({ page }) => {
  const details: string[] = [];
  const directories: string[] = [];
  await page.route("**/api/**", async route => {
    const { pathname: path, searchParams } = new URL(route.request().url());
    if (/\/threads\/[^/]+$/.test(path)) details.push(path);
    const setup = path.endsWith("/agents") && searchParams.get("view") === "setup";
    if (!setup && /\/(agents|teams|projects)$/.test(path)) directories.push(path);
    const body = path.endsWith("/auth/me") ? { authenticated: true, user: USER }
      : setup ? {
        view: "setup", defaultAgentOffers: [],
        onboardingAgents: [{
          id: "setup-agent", enabled: true, executorKind: "claude", availability: "ready",
          placements: [{ daemonNodeId: computer.id, desiredState: "active" }],
        }],
      } : { sessions: THREADS.slice(0, 20), agents: [], teams: [], tasks: [], nodes: [computer], projects: [], sandboxes: [] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/settings");
  await expect(page.locator(".sidenav-panel")).toBeVisible();
  await expect(page.locator(".sidenav-onboarding-count")).toHaveText("2/3");
  await page.waitForLoadState("networkidle");
  // Past the old preloader's idle timeout, even on a busy startup.
  await page.waitForTimeout(1600);
  expect(details).toEqual([]);
  expect(directories).toEqual([]);

  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.locator(".project-directory-empty")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(directories).toEqual(["/api/v1/projects"]);
});

for (const { route, panel, reads } of [
  { route: "/agents", panel: "#agents-panel", reads: ["agents:summary"] },
  { route: "/teams", panel: "#teams-panel", reads: ["agents:setup", "teams:summary"] },
  { route: "/computers", panel: "#computer-panel", reads: ["agents:setup"] },
  { route: "/skills", panel: "#skills-panel", reads: ["agents:setup"] },
  { route: "/projects", panel: ".project-directory-empty", reads: ["agents:setup", "projects:index"] },
]) {
  test(`${route} reads only the directory data it displays`, async ({ page }) => {
    const directoryRequests: string[] = [];
    await page.route("**/api/**", async request => {
      const { pathname, searchParams } = new URL(request.request().url());
      const catalog = pathname.match(/^\/api\/v1\/(agents|teams|projects)$/)?.[1];
      const view = searchParams.get("view");
      if (catalog) directoryRequests.push(`${catalog}:${view}`);
      const body = pathname.endsWith("/auth/me") ? { authenticated: true, user: USER }
        : view === "setup" ? { view, onboardingAgents: [], defaultAgentOffers: [] }
        : { agents: [], defaultAgentOffers: [], teams: [], nodes: [computer], sessions: [], skills: [], projects: [], homeTaskNeedsYou: 0 };
      await request.fulfill({ contentType: "application/json", json: body });
    });
    await page.goto(route);
    await expect(page.locator(panel)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(directoryRequests.sort()).toEqual(reads);
  });
}

test("a missing deep link shows a retry without another conversation or an enabled composer", async ({ page }) => {
  let missing = true;
  const thread = session("missing-link", 99, 1);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/threads/missing-link") && missing) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "Thread not found" }) });
      return;
    }
    const body = path.endsWith("/auth/me") ? { authenticated: true, user: USER }
      : path.endsWith("/threads/missing-link") ? thread
        : { sessions: THREADS.slice(0, 20), nextCursor: "older", agents: [], teams: [], tasks: [], nodes: [computer], projects: [], sandboxes: [] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/threads/missing-link");
  const error = page.locator('.transcript [role="alert"]');
  await expect(error).toContainText("Thread not found");
  await expect(page.locator(".transcript .msg")).toHaveCount(0);
  await expect(page.locator(".composer textarea")).toBeDisabled();
  missing = false;
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(error).toHaveCount(0);
  await expect(page.locator(".agent-code").last()).toContainText("turn0");
});

test("a thread summary stays visible when the conversation fails and can be retried", async ({ page }) => {
  let unavailable = true;
  let attempts = 0;
  const thread = session("thread-detail-retry", 0, 1);
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(`/threads/${thread.id}`)) {
      attempts++;
      await route.fulfill(unavailable
        ? { status: 503, json: { detail: "Conversation temporarily unavailable" } }
        : { json: thread });
      return;
    }
    const body = path.endsWith("/auth/me") ? { authenticated: true, user: USER }
      : { sessions: [thread], agents: [], teams: [], tasks: [], nodes: [computer], projects: [] };
    await route.fulfill({ json: body });
  });

  await page.goto(`/threads/${thread.id}`);
  await expect(page.getByRole("heading", { name: thread.title })).toBeVisible();
  const log = page.getByRole("log");
  const error = log.getByRole("alert");
  await expect(error).toContainText("Conversation temporarily unavailable");
  await expect(log.locator(".msg")).toHaveCount(0);
  unavailable = false;
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(log.locator(".agent-code").last()).toContainText("turn0");
  await expect(error).toHaveCount(0);
  expect(attempts).toBeGreaterThanOrEqual(2);
});
