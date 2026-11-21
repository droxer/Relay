import { expect, test, type Page } from "@playwright/test";

const connection = { id: "github-1", provider: "github", label: "Personal GitHub", identity: "octocat", status: "connected", actions: ["github.list_issues"] };
const mailbox = { id: "10aaf069-13fe-40a2-87b9-59b22bf47b78", provider: "gmail", label: "mail@example.com",
  identity: "mail@example.com", status: "connected", actions: ["gmail.list_messages", "gmail.get_message"] };
const outlookMailbox = { id: "c2b1c25b-dc8a-4ba8-9362-60216664d76e", provider: "outlook", label: "outlook@example.net",
  identity: "outlook@example.net", status: "connected", actions: ["outlook.list_messages", "outlook.get_message"] };
const mailProviders = [
  { id: "gmail", name: "Gmail", actions: mailbox.actions },
  { id: "outlook", name: "Outlook", actions: outlookMailbox.actions },
];
const stamp = "2026-11-06T00:00:00Z";

async function serve(page: Page, theme = "light", language = "en", runs: Record<string, unknown>[] = [], withMail = false) {
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
    if (path.endsWith("/connection-providers")) body = { providers: [
      { id: "github", name: "GitHub", configured: true, actions: connection.actions },
      ...mailProviders.map(provider => ({ ...provider, configured: withMail })),
    ] };
    if (path.endsWith("/connections")) body = { connections: [...(connected ? [connection] : []), ...(withMail ? [mailbox, outlookMailbox] : [])] };
    if (path.endsWith("/connections/github-1") && method === "DELETE") { connected = false; body = { disconnected: true }; }
    if (path.endsWith("/connections/github-1/usage")) body = { usage: [{ targetType: "automation", targetId: "routine-1" }] };
    if (path.endsWith("/connections/github-1/resources")) body = { resources: [{ id: "octo/hello", name: "octo/hello" }], nextCursor: null };
    if (path.endsWith(`/connections/${mailbox.id}/resources`)) body = { resources: [{ id: "inbox", name: "Inbox" }], nextCursor: null };
    if (path.endsWith("/connections/authorizations")) body = { url: `https://${route.request().postDataJSON().provider}.example.test/authorize` };
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
  await expect(page.getByText("Gmail", { exact: true })).toBeVisible();
  await expect(page.getByText("Outlook", { exact: true })).toBeVisible();
  for (const provider of mailProviders) {
    const icon = page.locator(`img[src="/brand/${provider.id}.svg"]`);
    await expect(icon).toBeVisible();
    await expect.poll(() => icon.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  }
  await expect(page.getByRole("button", { name: /Gmail|Outlook/ })).toHaveCount(0);
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

test("mailbox consent returns to the verified mailbox in Settings", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page, "dark", "en", [], true);
  await page.route("https://gmail.example.test/**", route => route.fulfill({ contentType: "text/html", body: "Google consent" }));
  await page.goto("/settings/connections");
  await page.getByRole("button", { name: "Connect Gmail", exact: true }).click();
  await expect(page.getByText(/Relay limits work to the Inbox/)).toBeVisible();
  const overflow = await page.locator("#settings-panel").evaluate(el => el.scrollWidth > el.clientWidth + 1);
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: "Continue to Gmail" }).click();
  await expect(page).toHaveURL("https://gmail.example.test/authorize");
  await page.goto(`/settings/connections?connectionResult=connected&connectionResultId=${mailbox.id}`);
  await expect(page.getByText("Connected as mail@example.com.")).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/connections$/);
});

for (const automation of [false, true]) test(`connection access in a new ${automation ? "automation" : "task"}`, async ({ page }) => {
  const saved = await serve(page);
  await page.goto(`/computers/device%3Au1%3Ahost/${automation ? "automations" : "tasks"}`);
  await page.getByRole("button", { name: automation ? "New automation" : "New task", exact: true }).first().click();
  const form = page.getByRole("dialog", { name: automation ? "New automation" : "New task", exact: true });
  await form.getByRole("textbox", { name: "Goal", exact: true }).fill("Read connected issues");
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

for (const automation of [false, true]) test(`Inbox access in a new ${automation ? "automation" : "task"}`, async ({ page }) => {
  const saved = await serve(page, "light", "en", [], true);
  const name = automation ? "New automation" : "New task";
  await page.goto(`/computers/device%3Au1%3Ahost/${automation ? "automations" : "tasks"}`);
  await page.getByRole("button", { name, exact: true }).first().click();
  const form = page.getByRole("dialog", { name, exact: true });
  await form.getByRole("textbox", { name: "Goal", exact: true }).fill("Summarize the Inbox");
  await form.locator("summary").filter({ hasText: "Connections" }).click();
  await expect(form.getByRole("checkbox", { name: /outlook@example\.net/ })).toBeVisible();
  for (const provider of mailProviders) await expect(form.locator(`img[src="/brand/${provider.id}.svg"]`)).toBeVisible();
  await form.getByRole("checkbox", { name: /mail@example\.com/ }).check();
  await form.getByRole("checkbox", { name: "Inbox", exact: true }).check();
  const list = form.getByRole("checkbox", { name: "List messages", exact: true });
  const body = form.getByRole("checkbox", { name: "Read message bodies", exact: true });
  await expect(list).not.toBeChecked();
  await expect(body).toBeDisabled();
  await list.check();
  await body.check();
  await form.getByRole("button", { name: automation ? "Create automation" : "Create task", exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].connectionGrants).toEqual([{ connectionId: mailbox.id, resources: ["inbox"], actions: mailbox.actions }]);
});

// Access is granted on tasks and automations, never from the chat composer:
// a new thread's first message carries no connection grants even with a
// service connected.
test("the composer sends a new Thread without connection access", async ({ page }) => {
  const runs: Record<string, unknown>[] = [];
  await serve(page, "light", "en", runs);
  await page.goto("/computers/device%3Au1%3Ahost/threads");
  const composer = page.locator(".composer").last();
  const message = composer.getByRole("textbox", { name: "Message Ada" });
  await expect(message).toBeVisible();
  await expect(composer.locator(".connection-grants")).toHaveCount(0);
  await message.fill("Read connected issues");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => runs.length).toBe(1);
  expect(runs[0].connectionGrants).toBeUndefined();
});
