import { test, expect, type Page } from "@playwright/test";

async function routePersonalRuntimes(page: Page, theme: "light" | "dark", language: "en" | "zh-CN") {
  const base = {
    userId: "computer-user", online: true, stale: false, dispatchable: true,
    status: "ready", nodeLocation: "user-device", sandboxMode: "none",
    activeRuns: [], queuedCommandCount: 0,
    lastSeenAt: "2026-11-28T06:00:00.000Z", updatedAt: "2026-11-28T06:00:00.000Z",
  };
  const computers = [
    { ...base, id: "desk", displayName: "Desk", agents: { codex: "ready", claude: "unresponsive", antigravity: "unresponsive" }, disabledAgents: [] as string[] },
    { ...base, id: "laptop", displayName: "Laptop", online: false, stale: true, dispatchable: false, agents: { codex: "ready", pi: "unknown" }, disabledAgents: ["pi"] },
  ];
  const writes: { id: string; disabledAgents: string[] }[] = [];
  let releaseFirstWrite = () => {};
  const firstWriteReleased = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/me")) {
      await route.fulfill({ json: { authenticated: true, user: { id: "alice", userId: base.userId, username: "alice", role: "user", theme, language } } });
      return;
    }
    if (path.endsWith("/daemon-nodes")) {
      await route.fulfill({ json: { nodes: computers } });
      return;
    }
    const node = computers.find(({ id }) => path.endsWith(`/daemon-nodes/${id}/disabled-agents`));
    if (route.request().method() === "PATCH" && node) {
      const { disabledAgents } = route.request().postDataJSON();
      writes.push({ id: node.id, disabledAgents });
      if (writes.length === 1) {
        await firstWriteReleased;
        await route.fulfill({ status: 503, json: { detail: "Temporarily unavailable" } });
        return;
      }
      node.disabledAgents = disabledAgents;
      node.updatedAt = new Date(Date.parse(base.updatedAt) + writes.length * 1000).toISOString();
      await route.fulfill({ json: { node } });
      return;
    }
    await route.fulfill({ json: { sessions: [], agents: [], teams: [], tasks: [], nodes: [], projects: [], sandboxes: [] } });
  });
  return { writes, releaseFirstWrite };
}

test("saves one runtime at a time per personal computer and retries a failed write", async ({ page }) => {
  const { writes, releaseFirstWrite } = await routePersonalRuntimes(page, "light", "en");
  await page.goto("/computers");
  const desk = page.locator(".computer-card").filter({ has: page.getByRole("heading", { name: "Desk", exact: true }) });
  const codex = desk.getByRole("switch", { name: "Codex on Desk", exact: true });
  const claude = desk.getByRole("switch", { name: "Claude on Desk", exact: true });
  const laptopCodex = page.getByRole("switch", { name: "Codex on Laptop", exact: true });
  const laptopPi = page.getByRole("switch", { name: "Pi on Laptop", exact: true });
  const confirm = page.getByRole("button", { name: "Save runtime settings", exact: true });

  await expect(codex).toBeChecked();
  await expect(laptopPi).not.toBeChecked();
  await expect(laptopCodex).toHaveAccessibleDescription("Offline");
  await codex.press("Space");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(writes).toEqual([]);
  await expect(codex).toBeChecked();

  await codex.press("Space");
  await confirm.click();
  await expect(desk.getByText("Saving…", { exact: true })).toBeVisible();
  await expect(codex).toBeChecked();
  await expect(claude).toBeDisabled();
  await expect(laptopPi).toBeEnabled();
  releaseFirstWrite();
  await expect(desk.getByRole("alert")).toHaveText("Could not save. Use the switch to try again.");
  await expect(codex).toBeChecked();

  await codex.click();
  await confirm.click();
  await expect(codex).not.toBeChecked();
  await expect(codex).toHaveAccessibleDescription("Ready");
  await expect(laptopCodex).toBeChecked();
  await claude.click();
  await expect(claude).not.toBeChecked();

  await page.reload();
  await expect(codex).not.toBeChecked();
  await expect(claude).not.toBeChecked();
  await codex.click();
  await expect(codex).toBeChecked();
  await expect(claude).not.toBeChecked();
  await laptopPi.click();
  await expect.poll(() => writes).toEqual([
    { id: "desk", disabledAgents: ["codex"] },
    { id: "desk", disabledAgents: ["codex"] },
    { id: "desk", disabledAgents: ["claude", "codex"] },
    { id: "desk", disabledAgents: ["claude"] },
    { id: "laptop", disabledAgents: [] },
  ]);
});

for (const theme of ["light", "dark"] as const) {
  test(`runtime controls fit phone, tablet and desktop in the ${theme} theme`, async ({ page }, testInfo) => {
    await routePersonalRuntimes(page, theme, "zh-CN");
    await page.goto("/computers");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const row = page.locator(".computer-runtime-row").filter({ has: page.getByRole("switch", { name: "Desk上的 Google Antigravity" }) });
    const control = row.getByRole("switch");

    for (const width of [360, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(row.getByText("无响应")).toBeVisible();
      await expect(row.getByText("已启用")).toBeVisible();
      await expect(control).toBeVisible();
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await control.evaluate((element) => {
        const target = getComputedStyle(element, "::after");
        const { width, height } = element.getBoundingClientRect();
        return Math.min(width - parseFloat(target.left) - parseFloat(target.right),
          height - parseFloat(target.top) - parseFloat(target.bottom));
      })).toBeGreaterThanOrEqual(44);
      await page.keyboard.press("Tab");
      await control.focus();
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS("outline-style", "solid");
      await page.screenshot({ path: testInfo.outputPath(`personal-runtimes-${width}.png`) });
    }
  });
}

test("computer owners preview and confirm report cleanup in the browser", async ({ page }, testInfo) => {
  const revision = "00000000-0000-4000-8000-000000000001";
  let pending = 139;
  let quarantined = 30;
  let changeBeforeDiscard = false;
  const discards: unknown[] = [];
  const results = new Map<string, object>();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [], agents: [], teams: [], tasks: [], nodes: [], projects: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", userId: "alice", username: "alice", role: "user", theme: "light", language: "en" } };
    if (path.endsWith("/daemon-nodes")) body = { nodes: [{
      id: "report-node", displayName: "Office Mac", userId: "alice", online: true, stale: false, dispatchable: true,
      status: "ready", agents: {}, activeRuns: [], capabilities: ["durable-reports", "report-cleanup"],
      transport: { state: "healthy", causes: quarantined ? ["quarantine"] : [], pending, quarantined },
    }] };
    if (path.endsWith("/report-cleanup")) {
      const input = route.request().postDataJSON();
      const commandId = String(results.size + 1);
      let outcome = "ready";
      let discarded: number | undefined;
      if (input.action === "discard") {
        discards.push(input);
        if (changeBeforeDiscard) {
          pending++;
          outcome = "changed";
        } else {
          discarded = input.scope === "quarantined" ? quarantined : pending;
          pending -= discarded;
          quarantined = 0;
          outcome = "discarded";
        }
      }
      results.set(commandId, { status: "completed", result: { outcome, pending, quarantined, revision, discarded } });
      return route.fulfill({ status: 202, json: { commandId } });
    }
    const match = /\/report-cleanup\/(\d+)$/.exec(path);
    if (match) body = results.get(match[1]!);
    await route.fulfill({ json: body });
  });
  await page.goto("/computers");
  await expect(page.getByText("139 retained · 30 quarantined")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("report-cleanup-desktop.png") });
  await page.setViewportSize({ width: 375, height: 812 });
  const card = page.locator(".computer-card");
  const quarantinedAction = card.getByRole("button", { name: "Clear quarantined", exact: true });
  await quarantinedAction.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("30 quarantined reports");
  await page.screenshot({ path: testInfo.outputPath("report-cleanup-confirmation.png") });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(discards).toEqual([]);
  await quarantinedAction.click();
  await dialog.getByRole("button", { name: "Clear quarantined", exact: true }).click();
  await expect(page.getByText("109 retained · 0 quarantined")).toBeVisible();
  await expect(page.getByText("30 reports discarded.")).toBeVisible();
  expect(discards).toEqual([{ action: "discard", scope: "quarantined", revision, acknowledgeOutputLoss: true }]);

  changeBeforeDiscard = true;
  await card.getByRole("button", { name: "Clear all reports", exact: true }).click();
  await expect(dialog).toContainText("109 retained reports");
  await dialog.getByRole("button", { name: "Clear all reports", exact: true }).click();
  await expect(page.getByText("The report queue changed. Review the counts and try again.")).toBeVisible();
  await expect(page.getByText("110 retained · 0 quarantined")).toBeVisible();
  expect(discards).toHaveLength(2);

  changeBeforeDiscard = false;
  await card.getByRole("button", { name: "Clear all reports", exact: true }).click();
  await expect(dialog).toContainText("110 retained reports");
  await dialog.getByRole("button", { name: "Clear all reports", exact: true }).click();
  await expect(page.getByText("0 retained · 0 quarantined")).toBeVisible();
  await expect(page.getByText("110 reports discarded.")).toBeVisible();
});

test("reads only the owner's inventory without writing sandbox credentials on opening Computers", async ({ page }) => {
  let adoptions = 0;
  let adminReads = 0;
  let ownerReads = 0;
  let releaseInventory!: () => void;
  const inventoryGate = new Promise<void>(resolve => { releaseInventory = resolve; });
  const user = { id: "alice", userId: "alice", username: "alice", role: "admin", theme: "light", language: "en" };
  const node = {
    id: "already-owned", userId: "alice", displayName: "Already owned", online: true, stale: false,
    status: "ready", activeRuns: [], agents: { codex: "ready" }, disabledAgents: [],
    nodeLocation: "user-device", sandboxMode: "none",
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [], homeTaskNeedsYou: 0, agents: [], teams: [], tasks: [], nodes: [], projects: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user };
    else if (path.endsWith("/admin/daemon-nodes")) {
      adminReads++;
      body = { nodes: [
        { ...node, nodeToken: "legacy-fixture-token" },
        { ...node, id: "someone-else", userId: "other", nodeToken: "other-fixture-token" },
      ] };
    } else if (path.endsWith("/daemon-nodes")) {
      ownerReads++;
      await inventoryGate;
      body = { nodes: [node] };
    } else if (path.endsWith("/sandboxes") && route.request().method() === "POST") {
      adoptions++;
      body = node;
    }
    await route.fulfill({ json: body });
  });
  try {
    const ownerInventory = page.waitForRequest(request => new URL(request.url()).pathname === "/api/v1/daemon-nodes");
    await page.goto("/computers");
    await ownerInventory;
    // Hold the owner's list until the shell has mounted.
    await expect(page.locator(".sidenav-nav")).toBeVisible();
    expect(adoptions).toBe(0);
    releaseInventory();
    await expect(page.locator(".computer-card")).toHaveCount(1);
    expect(adoptions).toBe(0);
    expect(ownerReads).toBe(1);
    expect(adminReads).toBe(0);
  } finally {
    releaseInventory();
  }
});

test("computer approval preserves its URL and requires explicit consent", async ({ page }) => {
  let approvals = 0;
  const code = "abcdefghijklmnopqrstuvwxyz123456";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [], agents: [], teams: [], tasks: [], nodes: [], projects: [], sandboxes: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", userId: "computer-user", username: "alice", role: "user", theme: "light", language: "en" } };
    if (path.endsWith(`/computer-authorizations/${code}`)) body = { displayName: "Alice laptop", workspacePath: "/Users/alice/work", status: "pending" };
    if (path.endsWith(`/computer-authorizations/${code}/approve`)) { approvals++; body = { status: "approved" }; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(`/computer?connect=${code}`);
  await expect(page.getByRole("heading", { name: "Connect this computer?" })).toBeVisible();
  await expect(page.getByText("/Users/alice/work", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`connect=${code}`));
  expect(approvals).toBe(0);
  await page.getByRole("button", { name: "Connect computer", exact: true }).click();
  await expect(page.getByText("Return to your terminal. Setup finishes there on its own.")).toBeVisible();
  expect(approvals).toBe(1);
});

for (const language of ["en", "zh-CN", "zh-TW"]) {
  test(`runtime hover guidance and keyboard diagnostics follow ${language}`, async ({ page }, testInfo) => {
    const diagnostic = "Codex check failed (exit code 1).\nOriginal CLI output: /usr/bin/codex";
    const labels = {
      en: { hint: "The readiness check failed. Inspect the original diagnostic for details.", details: "Runtime details", original: "Original diagnostic" },
      "zh-CN": { hint: "就绪检查失败。请展开原始诊断查看详情。", details: "运行时详情", original: "原始诊断" },
      "zh-TW": { hint: "就緒檢查失敗。請展開原始診斷查看詳情。", details: "執行環境詳情", original: "原始診斷" },
    }[language]!;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [], agents: [], teams: [], tasks: [], nodes: [], projects: [], sandboxes: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", userId: "computer-user", username: "alice", role: "user", theme: "light", language } };
      if (path.endsWith("/daemon-nodes")) body = { nodes: [{ id: "tooltip-node", displayName: "Tooltip computer", userId: "computer-user", online: true, stale: false, status: "ready", nodeLocation: "user-device", sandboxMode: "none", agents: { codex: "failed" }, disabledAgents: [], activeRuns: [], agentDetails: { codex: { detail: diagnostic, version: "1.2.3" } } }] };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/computers");
    const row = page.locator(".computer-runtime-row").filter({ hasText: "Codex" });
    await expect(row).toHaveAttribute("title", new RegExp(labels.hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(await row.getAttribute("title")).not.toContain(diagnostic);
    await page.locator(".computer-card-actions button").click();
    await page.getByRole("menuitem", { name: labels.details, exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("switch")).toHaveCount(0);
    const summary = page.locator(".adm-agent-toggle-diagnostic summary");
    await expect(summary).toHaveText(labels.original);
    const output = page.locator(".adm-agent-toggle-diagnostic pre");
    await expect(output).not.toBeVisible();
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(output).toBeVisible();
    expect(await output.textContent()).toBe(diagnostic);
    expect(await output.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("runtime-diagnostic.png") });
  });
}

test("a computer that is not plainly online says why and what to do", async ({ page }, testInfo) => {
  const node = (id: string, displayName: string, extra: Record<string, unknown>) => ({
    id, displayName, userId: "computer-user", online: true, stale: false, dispatchable: true, status: "ready",
    nodeLocation: "user-device", sandboxMode: "none", agents: { codex: "ready" }, disabledAgents: [], activeRuns: [],
    queuedCommandCount: 0, lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(), capabilities: ["durable-reports"], ...extra,
  });
  const transport: Record<string, unknown> = {
    "retrying-node": { state: "retrying", causes: [], pending: 3 },
    "quarantine-node": { state: "healthy", causes: ["quarantine"], quarantined: 2 },
    "healthy-node": { state: "healthy", causes: [] },
  };
  const asked: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { sessions: [], agents: [], teams: [], tasks: [], nodes: [], projects: [], sandboxes: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "alice", userId: "computer-user", username: "alice", role: "user", theme: "light", language: "en" } };
    if (path.endsWith("/daemon-nodes")) body = { nodes: [
      node("healthy-node", "Healthy computer", { transport: transport["healthy-node"] }),
      node("offline-node", "Offline computer", { online: false, stale: true, dispatchable: false }),
      node("stopped-node", "Stopped computer", { online: false, stale: true, dispatchable: false, status: "stopped" }),
      node("retrying-node", "Retrying computer", { transport: transport["retrying-node"] }),
      node("deaf-node", "Deaf computer", { dispatchable: false, capabilities: [] }),
      node("quarantine-node", "Quarantine computer", { transport: transport["quarantine-node"] }),
    ] };
    const match = /\/daemon-nodes\/([^/]+)\/transport$/.exec(path);
    if (match) { asked.push(match[1]!); body = transport[match[1]!] ?? { state: "connecting", verified: false }; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/computers");
  const card = (name: string) => page.locator(".computer-card").filter({ hasText: name });

  await expect(card("Healthy computer").locator(".adm-presence-pill")).toHaveText("Online");
  await expect(card("Healthy computer").locator(".computer-card-connection")).toHaveCount(0);

  const offline = card("Offline computer").locator(".computer-card-connection");
  await expect(card("Offline computer").locator(".adm-presence-pill")).toHaveText("Offline");
  await expect(offline.locator(".computer-card-connection-title")).toHaveCount(0);
  await expect(offline).toContainText("Relay reconnects on its own");
  await expect(offline.locator("code")).toHaveText("relay status");
  // Absence is not failure: a dark computer speaks in the neutral voice.
  await expect(offline).toHaveAttribute("data-tone", "neutral");

  await expect(card("Stopped computer").locator(".computer-card-connection code")).toHaveText("relay start");

  const retrying = card("Retrying computer");
  await expect(retrying.locator(".adm-presence-pill")).toHaveText("Reconnecting");
  await expect(retrying.locator(".computer-card-connection")).toContainText("Connection unstable");
  await expect(retrying.locator(".computer-card-connection")).toContainText("3 reports waiting to upload");

  // Alive but not taking work: said from liveness alone, no snapshot needed.
  await expect(card("Deaf computer").locator(".adm-presence-pill")).toHaveText("Reconnecting");
  await expect(card("Deaf computer").locator(".computer-card-connection")).toContainText("not picking up new work yet");

  const quarantine = card("Quarantine computer").locator(".computer-card-connection");
  await expect(quarantine).toContainText("Some reports were refused");
  await expect(quarantine.locator("code")).toHaveText("relay reports");
  await expect(card("Quarantine computer").locator(".adm-presence-pill")).toHaveText("Online");
  expect(asked).toEqual([]);

  // The notice never widens its card.
  for (const notice of await page.locator(".computer-card-connection").all()) {
    expect(await notice.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("computer-connection.png"), fullPage: true });
});
