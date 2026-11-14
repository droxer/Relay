import { expect, test, type Page } from "@playwright/test";

const connection = { id: "github-1", provider: "github", label: "Personal GitHub", identity: "octocat", status: "connected", actions: ["github.list_issues"] };
const providers = [
  { id: "github", name: "GitHub", configured: true, actions: ["github.list_issues"] },
];
const stamp = "2026-11-06T00:00:00Z";

async function serve(page: Page, theme = "light", language = "en", runs: Record<string, unknown>[] = []) {
  let connected = true;
  const saved: Record<string, unknown>[] = [];
  const computerId = "device:u1:host";
  const node = { id: "node", userId: "u1", workspaceId: "host", computerId, name: "Work computer", activeRuns: [],
    online: true, stale: false, status: "ready", agents: { codex: "ready" }, capabilities: ["thread-workspaces", "service-connections", "image-attachments"] };
  const agent = { id: "agent", displayName: "Ada", executorKind: "codex", defaultRole: "implementer", supervisorUserId: "u1",
    enabled: true, availability: "ready", version: 1, skills: [], computerId,
    placements: [{ id: "placement", agentId: "agent", computerId, daemonNodeId: "node", desiredState: "active", status: "ready" }],
    createdAt: stamp, updatedAt: stamp };
  const thread = { id: "new-thread", title: "Read connected issues", taskGoal: "Read connected issues", ownerUserId: "u1", ownerAgentId: "agent",
    daemonNodeId: "node", computerId, workspacePath: "/workspace", status: "completed", phase: "completed", participants: ["human"],
    events: [], agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], createdAt: stamp, updatedAt: stamp };
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body: unknown = { tasks: [], sessions: [], agents: [agent], teams: [], nodes: [node], projects: [], sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "a1", userId: "u1", username: "ada", role: "user", theme, language } };
    if (path.endsWith("/connection-providers")) body = { providers };
    if (path.endsWith("/connections")) body = { connections: connected ? [connection] : [] };
    if (path.endsWith("/connections/github-1") && method === "DELETE") { connected = false; body = { disconnected: true }; }
    if (path.endsWith("/connections/github-1/usage")) body = { usage: [{ targetType: "automation", targetId: "routine-1" }] };
    if (path.endsWith("/connections/github-1/resources")) body = { resources: [{ id: "octo/hello", name: "octo/hello" }], nextCursor: null };
    if (path.endsWith("/connections/authorizations")) body = { url: "https://github.example.test/authorize" };
    if (path.endsWith("/automations/schedule-preview")) body = { next: [], summary: "Weekdays at 09:00", timezone: "UTC" };
    if (path.endsWith("/agent-runs") && method === "POST") { runs.push(route.request().postDataJSON()); body = thread; }
    if (path.endsWith("/threads/new-thread")) body = thread;
    if (path.includes("/connection-grants/")) body = { grants: [], readOnly: false, targetType: "thread", targetId: "new-thread" };
    if (path.endsWith("/tasks") && method === "POST") {
      const input = route.request().postDataJSON();
      saved.push(input);
      body = { ...input, id: "new-task", ownerUserId: "u1", status: "backlog", createdAt: stamp, updatedAt: stamp, linkedSessionIds: [] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return saved;
}

for (const [name, viewport, theme, language] of [
  ["desktop", { width: 1440, height: 960 }, "light", "en"],
  ["mobile", { width: 390, height: 844 }, "dark", "en"],
  ["chinese", { width: 390, height: 844 }, "light", "zh-CN"],
] as const) test(`Connections settings and disconnect impact (${name})`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await serve(page, theme, language);
  await page.goto("/settings/connections");
  await expect(page.getByText("octocat", { exact: true })).toBeVisible();
  await expect(page.getByText("Slack", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Gmail", { exact: true })).toHaveCount(0);
  const panel = page.locator("#settings-panel");
  const overflow = await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1);
  expect(overflow).toBe(false);
  await page.screenshot({ path: `../.impeccable/review/connections-${name}.png`, fullPage: true });
  await page.getByRole("button", { name: language === "en" ? "Disconnect" : "断开连接", exact: true }).click();
  await expect(page.getByText(language === "en" ? /New service calls will stop/ : /后续服务调用将停止/)).toBeVisible();
  await page.getByRole("button", { name: language === "en" ? "Disconnect service" : "断开服务", exact: true }).click();
  await expect(page.getByText("octocat", { exact: true })).toHaveCount(0);
});

test("Connect redirects to provider authentication", async ({ page }) => {
  await serve(page);
  await page.route("https://github.example.test/**", route => route.fulfill({ contentType: "text/html", body: "Provider authentication" }));
  await page.goto("/settings/connections");
  await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await expect(page).toHaveURL("https://github.example.test/authorize");
});

for (const automation of [false, true]) test(`connection access in a new ${automation ? "automation" : "task"}`, async ({ page }) => {
  const saved = await serve(page);
  await page.goto(`/computers/device%3Au1%3Ahost/${automation ? "automations" : "tasks"}`);
  await page.getByRole("button", { name: automation ? "New automation" : "New task", exact: true }).first().click();
  const form = page.getByRole("dialog", { name: automation ? "New automation" : "New task", exact: true });
  await form.getByRole("textbox", { name: "Title", exact: true }).fill("Read connected issues");
  if (automation) {
    await form.locator("summary").filter({ hasText: "Connections" }).click();
    await form.getByRole("checkbox", { name: /Personal GitHub/ }).check();
    await form.getByRole("checkbox", { name: "octo/hello", exact: true }).check();
  } else {
    await expect(form.locator(".connection-grants")).toHaveCount(0);
  }
  await form.getByRole("button", { name: automation ? "Create automation" : "Create task", exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  if (automation) {
    expect(saved[0].connectionGrants).toEqual([{ connectionId: "github-1", resources: ["octo/hello"], actions: ["github.list_issues"] }]);
  } else {
    expect(saved[0].connectionGrants ?? []).toEqual([]);
  }
});

test("new Thread sends selected connection access with its first message", async ({ page }) => {
  const runs: Record<string, unknown>[] = [];
  await serve(page, "light", "en", runs);
  await page.goto("/computers/device%3Au1%3Ahost/threads");
  const composer = page.locator(".composer").last();
  await composer.locator("summary").filter({ hasText: "Connections" }).click();
  await composer.getByRole("checkbox", { name: /Personal GitHub/ }).check();
  await composer.getByRole("checkbox", { name: "octo/hello", exact: true }).check();
  await composer.getByRole("textbox").fill("Read connected issues");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => runs.length).toBe(1);
  expect(runs[0].connectionGrants).toEqual([{ connectionId: "github-1", resources: ["octo/hello"], actions: ["github.list_issues"] }]);
});

test("the composer offers no connections until a service is connected", async ({ page }) => {
  await serve(page);
  await page.route("**/api/v1/connections", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ connections: [] }) }));
  const listed = page.waitForResponse(response => response.url().endsWith("/api/v1/connections"));
  await page.goto("/computers/device%3Au1%3Ahost/threads");
  await listed;
  const composer = page.locator(".composer").last();
  await expect(composer.getByRole("textbox")).toBeVisible();
  await expect(composer.locator(".connection-grants")).toHaveCount(0);
});
