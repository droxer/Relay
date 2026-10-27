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
