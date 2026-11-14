import { test, expect } from "@playwright/test";

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
      en: { hint: "The readiness check failed. Inspect the original diagnostic for details.", manage: "Manage runtimes", original: "Original diagnostic" },
      "zh-CN": { hint: "就绪检查失败。请展开原始诊断查看详情。", manage: "管理运行时", original: "原始诊断" },
      "zh-TW": { hint: "就緒檢查失敗。請展開原始診斷查看詳情。", manage: "管理執行時", original: "原始診斷" },
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
    await page.getByRole("menuitem", { name: labels.manage, exact: true }).click();
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
