import { expect, test, type Page } from "@playwright/test";

/* Home: the signed-in landing. A ranked "Up next" queue (a paused run, then
   what needs the person, then what is stuck, then what is worth doing) beside
   their tasks, projects, running work, and what finished. Each inline action
   is asserted on the wire, not only on screen. */
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const yesterday = new Date(now - 86_400_000);
const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const computerId = "device:u:host";
const agent = {
  id: "agt_atlas", displayName: "Atlas", executorKind: "claude", defaultRole: "implementer", supervisorUserId: "u",
  enabled: true, availability: "ready", version: 1, skills: [], deletedAt: null, createdAt: ago(9000), updatedAt: ago(9000),
  placements: [{ id: "pl-atlas", agentId: "agt_atlas", computerId, daemonNodeId: "node", desiredState: "active", status: "ready" }],
};
const node = {
  id: "node", userId: "u", workspaceId: "host", computerId, displayName: "build-mac", status: "ready", online: true, stale: false,
  agents: { claude: "ready" }, queuedCommandCount: 0, createdAt: ago(9000), updatedAt: ago(1),
  activeRuns: [{ commandId: "c1", sessionId: "s-migrate", runId: "run-m", agent: "claude", logicalAgentId: "agt_atlas", taskGoal: "Migrate", startedAt: ago(12) }],
};
const darkNode = { ...node, id: "node-2", workspaceId: "host-2", computerId: "device:u:host-2", displayName: "studio-linux", online: false, activeRuns: [], lastSeenAt: ago(47) };

const thread = (id: string, extra: Record<string, unknown>) => ({
  id, title: id, taskGoal: id, workspacePath: "/workspace", computerId, daemonNodeId: "node", ownerUserId: "u",
  status: "completed", phase: "completed", createdAt: ago(600), updatedAt: ago(180),
  agentRuns: [], artifacts: [], decisions: [], events: [], eventCount: 0, artifactCount: 0, runCount: 1, permissionRequests: [],
  ...extra,
});
const migrate = thread("s-migrate", {
  title: "Migrate billing tables", status: "running", phase: "running", projectId: "p-billing", updatedAt: ago(2),
  permissionRequests: [{
    id: "req-1", runId: "run-m", agent: "claude", logicalAgentId: "agt_atlas", toolName: "Bash",
    input: JSON.stringify({ command: "psql -f migrations/0042_split_invoices.sql" }), requestedAt: ago(2),
  }],
});
const pricing = thread("s-pricing", { title: "Pricing page copy", projectId: "p-site" });
const webhook = thread("s-webhook", { title: "Webhook retries", projectId: "p-billing", nextSteps: ["Add an alert when retries exceed the budget"] });

const task = (id: string, number: number, extra: Record<string, unknown>) => ({
  id, number, title: id, description: "", priority: "normal", status: "assigned", isRoutine: false, linkedSessionIds: [],
  ownerUserId: "u", projectId: "p-billing", createdAt: ago(5000), updatedAt: ago(300), ...extra,
});
const tasks = [
  task("t-ready", 27, {title:"Ship the customer export", assignedAgentId:"agt_atlas", priority:"high", waitingOn:[]}),
  task("t-due", 28, {title:"Review the release checklist", dueDate:isoDay(new Date(now+86400000))}),
  task("routine-report", 29, {title:"Weekly delivery report", isRoutine:true, routineState:"active", routineNextRunAt:ago(-1440)}),
  task("t-pricing", 9, {
    title: "Pricing page copy refresh", status: "waiting_for_human", projectId: "p-site", updatedAt: ago(38), assignedAgentId: "agt_atlas",
    awaiting: { questionId: "w-9", kind: "question", text: "Should the annual plan show the monthly equivalent or the yearly total?", options: ["Monthly equivalent", "Yearly total"], notes: [], sessionId: "s-pricing", resumable: true },
  }),
  task("t-retry", 7, { title: "Add retry budget to webhook sender", status: "review", updatedAt: ago(180), finishedAt: ago(180), assignedAgentId: "agt_atlas" }),
  task("t-load", 16, { title: "Load-test invoice export", status: "blocked", updatedAt: ago(1440), blockerReason: "Waiting on #14 to land first.", waitingOn:["upstream"], waitingOnSummaries:[{id:"upstream",number:14,title:"Complete the billing schema",status:"running",ownerUserId:"sam",responsibleName:"Sam Lee",canOpen:false}] }),
  task("t-soc2", 5, { title: "Quarterly SOC2 evidence pull", projectId: "p-compliance", dueDate: isoDay(yesterday) }),
  task("t-intake", 21, { title: "Look into flaky login", projectId: undefined, status: "backlog" }),
  task("t-sdk", 18, { title: "Generate SDK types", status: "running", updatedAt: ago(5) }),
  task("t-done", 3, { title: "Accessibility pass on checkout", status: "done", projectId: "p-site", finishedAt: ago(1500), updatedAt: ago(1500) }),
];
const project = (id: string, name: string) => ({
  id, name, ownerUserId: "u", computerId, workspaceLayout: "project", workspaceSubpath: `projects/${id}`, leadAgentId: null,
  members: [], enabled: true, version: 1, createdAt: ago(9000), updatedAt: ago(600),
});
const projects = [project("p-billing", "Billing v2"), project("p-site", "Website"), project("p-compliance", "Compliance")];

type Theme = "light" | "dark";
type Wire = { method: string; path: string; body: unknown };

async function serve(page: Page, theme: Theme) {
  const wire: Wire[] = [];
  let snoozes: unknown[] = [];
  const user = () => ({ id: "u", userId: "u", username: "fei", displayName: "Fei He", role: "user", theme, language: "en", homeSnoozes: snoozes });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") wire.push({ method: request.method(), path, body: JSON.parse(request.postData() ?? "null") });
    if (path.endsWith("/events")) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      return;
    }
    let body: unknown = {
      sessions: [migrate, pricing, webhook], agents: [agent], teams: [], tasks, nodes: [node, darkNode], projects, sandboxes: [], skills: [],
    };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: user() };
    if (path.endsWith("/auth/preferences")) {
      const patch = (wire.at(-1)?.body as { homeSnoozes?: { snooze?: unknown[] } })?.homeSnoozes;
      snoozes = [...snoozes, ...(patch?.snooze ?? [])];
      body = { user: user() };
    }
    if (path.includes("/threads/s-")) body = path.includes("s-migrate") ? migrate : path.includes("s-pricing") ? pricing : webhook;
    if (path.includes("/tasks/t-")) body = tasks.find((item) => path.includes(item.id));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return wire;
}

const queue = (page: Page) => page.getByRole("region", { name: "Up next" });

for (const theme of ["dark", "light"] as const) {
  test(`a signed-in visitor lands on Home and sees what needs them first (${theme})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await serve(page, theme);
    await page.goto("/");

    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Fei");
    await expect(page.locator(".home-brief")).toContainText("3 things need you");
    await expect(page.getByRole("link", { name: "Home, 3 things need you" })).toBeVisible();

    await expect(queue(page).locator(".home-band-title")).toHaveText([
      "Needs you", "Stuck", "Worth doing",
    ]);
    await expect(queue(page).getByRole("heading", {name:"Start here"})).toBeVisible();
    await expect(queue(page).locator(".home-item-title").filter({hasText:"Migrate billing tables"})).toHaveCount(1);
    await expect(page.getByRole("region", {name:"Upcoming"})).toContainText("Review the release checklist");
    await expect(queue(page).locator(".home-item-title").first()).toContainText("Migrate billing tables");
    await expect(queue(page).locator(".home-item-why").first()).toContainText("psql -f migrations/0042_split_invoices.sql");
    await expect(page.getByRole("region", { name: "Projects" })).toContainText("Billing v2");
    await expect(page.getByRole("region", { name: "Running now" })).toContainText("paused for permission");
    await page.screenshot({ path: testInfo.outputPath(`home-${theme}.png`), fullPage: true });
  });
}

test("answers a paused run's permission prompt in place", async ({ page }) => {
  const wire = await serve(page, "dark");
  await page.goto("/home");

  const row = queue(page).locator(".home-item").filter({ hasText: "Migrate billing tables" });
  await row.getByRole("button", { name: "Allow", exact: true }).click();

  await expect.poll(() => wire.find((call) => call.path.endsWith("/permission-requests/req-1"))?.body).toEqual({ decision: "allow" });
  await expect(row).toHaveCount(0);
});

test("answers a question with one of the agent's options, naming the question", async ({ page }) => {
  const wire = await serve(page, "dark");
  await page.goto("/home");

  await queue(page).getByRole("button", { name: "Yearly total" }).click();

  await expect.poll(() => wire.find((call) => call.path.endsWith("/threads/s-pricing/messages"))?.body).toMatchObject({
    text: "Yearly total", intent: "accomplish", questionId: "w-9",
  });
});

test("accepts finished work and snoozes the rest until it changes", async ({ page }) => {
  const wire = await serve(page, "dark");
  await page.goto("/home");

  const review = queue(page).locator(".home-item").filter({ hasText: "Add retry budget" });
  await review.getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => wire.find((call) => call.path.endsWith("/tasks/t-retry"))?.body).toEqual({ status: "done" });

  const blocked = queue(page).locator(".home-item").filter({ hasText: "Load-test invoice export" });
  await blocked.getByRole("button", { name: "Snooze" }).click();
  await expect.poll(() => wire.find((call) => call.path.endsWith("/auth/preferences"))?.body).toEqual({
    homeSnoozes: { snooze: [{ key: "task:t-load", stamp: tasks.find(task => task.id === "t-load")!.updatedAt }] },
  });
  await expect(blocked).toHaveCount(0);
});

test("stacks into one column on a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page, "light");
  await page.goto("/home");

  await expect(queue(page)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("home-phone.png"), fullPage: true });
});


test("recommends ready work when urgent items are clear and preserves queued outcomes", async ({page}) => {
 await serve(page,"light");
 const ready=tasks.find(task=>task.id==="t-ready")!;
 await page.route("**/api/v1/tasks?*",route=>route.fulfill({json:{tasks:[ready]}}));
 await page.route("**/api/v1/threads?*",route=>route.fulfill({json:{sessions:[]}}));
 await page.route("**/api/v1/tasks/t-ready/runs",route=>route.fulfill({json:{task:{...ready,events:[],activity:[]},session:null,dispatch:{state:"queued"}}}));
 await page.goto("/home");
 const focus=page.locator(".home-focus");
 await expect(focus).toContainText("Ship the customer export");
 await expect(page.locator(".home-item-title").filter({hasText:"Ship the customer export"})).toHaveCount(1);
 await focus.getByRole("button",{name:"Start",exact:true}).click();
 await expect(focus.getByRole("status")).toContainText("Queued");
 await expect(focus.getByRole("status")).not.toContainText("Work started");
});

test("shows a failed source instead of claiming the queue is clear", async ({page}) => {
 await serve(page,"light");
 await page.route("**/api/v1/tasks?*",route=>route.fulfill({status:503,json:{detail:"Unavailable"}}));
 await page.goto("/home");
 await expect(page.locator(".home-data-state")).toBeVisible();
 await expect(page.locator(".home-clear")).toHaveCount(0);
 await expect(page.locator(".home-data-state").getByRole("button",{name:"Retry"})).toBeVisible({timeout:20000});
});

test("a focused decision does not produce a false all-clear message", async ({page}) => {
 await serve(page,"light");
 await page.route("**/api/v1/tasks?*",route=>route.fulfill({json:{tasks:[]}}));
 await page.route("**/api/v1/threads?*",route=>route.fulfill({json:{sessions:[migrate]}}));
 await page.goto("/home");
 await expect(page.locator(".home-focus")).toContainText("Migrate billing tables");
 await expect(queue(page)).toContainText("No other items need you");
 await expect(queue(page)).not.toContainText("Nothing needs you right now");
});

test("reveals all ready work without leaving Home", async ({page}) => {
 await serve(page,"light");
 const ready=tasks.find(task=>task.id==="t-ready")!;
 const many=Array.from({length:5},(_,i)=>({...ready,id:`ready-${i}`,title:`Ready item ${i}`}));
 await page.route("**/api/v1/tasks?*",route=>route.fulfill({json:{tasks:many}}));
 await page.route("**/api/v1/threads?*",route=>route.fulfill({json:{sessions:[]}}));
 await page.goto("/home");
 const panel=page.getByRole("region",{name:"Ready to start"});
 await expect(panel.locator(".home-ready-row")).toHaveCount(3);
 await panel.getByRole("button",{name:"Show all 4"}).click();
 await expect(panel.locator(".home-ready-row")).toHaveCount(4);
 await panel.getByRole("button",{name:"Show less"}).click();
 await expect(panel.locator(".home-ready-row")).toHaveCount(3);
});

test("phone users can jump to Upcoming immediately after the recommendation", async ({page}) => {
 await serve(page,"dark");await page.setViewportSize({width:375,height:812});await page.goto("/home");
 const link=page.getByRole("navigation",{name:"Jump to your work"}).getByRole("link",{name:/Upcoming/});
 await expect(link).toBeVisible();
 const height=await link.evaluate(el=>el.getBoundingClientRect().height);expect(height).toBeGreaterThanOrEqual(44);
 await link.click();
 await expect(page.getByRole("heading",{name:"Upcoming",exact:true})).toBeInViewport();
});
