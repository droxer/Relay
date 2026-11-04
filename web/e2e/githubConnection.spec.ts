import { expect, test } from "@playwright/test";

for (const layout of ["desktop", "narrow", "mobile"] as const) {
  test(`Public GitHub imports and coming-soon connection (${layout})`, async ({ page }) => {
    const mobile = layout === "mobile";
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    if (layout === "narrow") await page.addInitScript(() => localStorage.setItem("relay-web.drawerWidth.detail", "420"));
    const user = { id: "a1", userId: "u1", username: "ada", role: "user", theme: mobile ? "dark" : "light", language: "en" };
    const issues = Array.from({ length: 55 }, (_, index) => ({ number: index + 1, title: `Issue ${index + 1}`,
      url: `https://github.com/octo/hello/issues/${index + 1}`, state: "open", labels: ["bug"],
      author: "octocat", comments: 0, importedTaskId: null }));
    issues[0].title = "Keep the original repository context visible when importing a very long issue title with multiple acceptance criteria";
    issues[0].labels = ["bug", "cross-platform-compatibility-and-localization", "a".repeat(80)];
    let connectionRequests = 0;
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { tasks: [], sessions: [], agents: [], teams: [], nodes: [], projects: [], sandboxes: [], skills: [], notifications: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user };
      if (path.includes("/account/github")) connectionRequests += 1;
      if (path.endsWith("/tasks/github/issues")) {
        const { page: number } = route.request().postDataJSON();
        body = { repository: { owner: "octo", name: "hello", fullName: "octo/hello" }, page: number,
          hasMore: number === 1, issues: number === 1 ? issues.slice(0, 50) : issues.slice(50) };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/tasks?githubImport=1");
    const drawer = page.getByRole("dialog", { name: "Import GitHub issues" });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveCSS("opacity", "1");
    await expect(drawer.getByText("Coming soon", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: /Connect GitHub|Reconnect GitHub/ })).toHaveCount(0);
    await expect(drawer.locator('input[type="password"]')).toHaveCount(0);
    await expect(drawer.getByText("Import issues from public repositories now. GitHub connection for private repositories is coming soon.")).toBeVisible();
    await page.screenshot({ path: `/tmp/relay-github-polish-${layout}-initial.png`, fullPage: true, animations: "disabled" });
    await drawer.getByRole("textbox", { name: /^Repository\b/ }).fill("octo/hello");
    await drawer.getByRole("button", { name: "Load issues", exact: true }).click();
    await drawer.getByRole("button", { name: "Load more", exact: true }).click();
    const selectAll = drawer.getByRole("checkbox", { name: /^Select all new issues\b/ });
    await selectAll.click();
    await expect(drawer.getByText("50 of 55 selected", { exact: true })).toBeVisible();
    await expect(drawer.locator('.github-import-row[data-selected="true"]')).toHaveCount(50);
    expect(await drawer.locator(".github-import-row").evaluateAll((rows) => rows.every((row) => row.scrollWidth <= row.clientWidth))).toBe(true);
    await page.screenshot({ path: `/tmp/relay-github-polish-${layout}-selected.png`, fullPage: true, animations: "disabled" });
    await selectAll.click();
    await expect(drawer.getByText("0 of 55 selected", { exact: true })).toBeVisible();
    expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await page.goto("/settings/account");
    const connection = page.getByRole("region", { name: "Connections", exact: true });
    await expect(connection.getByText("Coming soon", { exact: true })).toBeVisible();
    await expect(connection.getByRole("button")).toHaveCount(0);
    expect(connectionRequests).toBe(0);
  });
}

test("GitHub import has clear loading, recovery, empty, and imported states", async ({ page }) => {
  let mode: "error" | "empty" | "issues" = "error";
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = { tasks: [], sessions: [], agents: [], teams: [], nodes: [], projects: [], sandboxes: [], skills: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "a1", userId: "u1", username: "ada", role: "user", theme: "light", language: "en" } };
    if (path.endsWith("/tasks/github/issues")) {
      if (mode === "error") {
        await pending;
        await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ detail: "github_unreachable" }) });
        return;
      }
      body = { repository: { owner: "octo", name: "hello", fullName: "octo/hello" }, page: 1, hasMore: false,
        issues: mode === "empty" ? [] : [1, 2].map((number) => ({ number, title: number === 1 ? "Already imported issue" : "An issue ready to import",
          url: `https://github.com/octo/hello/issues/${number}`, state: "open", labels: ["bug"], comments: 0,
          author: "octocat", importedTaskId: number === 1 ? "existing-task" : null })) };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/tasks?githubImport=1");
  const drawer = page.getByRole("dialog", { name: "Import GitHub issues" });
  await expect(drawer).toHaveCSS("opacity", "1");
  const repository = drawer.getByRole("textbox", { name: /^Repository\b/ });
  await repository.fill("octo/hello");
  const load = drawer.locator(".github-import-query-actions button");
  await expect(load).toHaveAttribute("data-variant", "default");
  await load.click();
  await expect(load).toHaveAttribute("aria-busy", "true");
  await expect(repository).toBeDisabled();
  await expect(drawer.getByRole("button", { name: "Open", exact: true })).toBeDisabled();
  release();
  await expect(drawer.getByRole("alert")).toContainText("GitHub could not be reached");
  await expect(repository).toBeEnabled();
  mode = "empty";
  await load.click();
  await expect(drawer.getByRole("status")).toContainText("No issues match.");
  await expect(drawer.getByRole("alert")).toHaveCount(0);
  mode = "issues";
  await load.click();
  const imported = drawer.locator('.github-import-row[data-imported="true"]');
  await expect(imported.locator(".github-import-row-mark svg")).toBeVisible();
  await expect(imported.getByRole("checkbox")).toHaveCount(0);
  const checkbox = drawer.getByRole("checkbox", { name: "Import #2: An issue ready to import", exact: true });
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await expect(drawer.getByRole("button", { name: "Import 1 issue", exact: true })).toBeEnabled();
  await page.screenshot({ path: "/tmp/relay-github-polish-imported.png", fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
});
