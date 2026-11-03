import { expect, test } from "@playwright/test";

for (const mobile of [false, true]) {
  test(`GitHub connection and capped issue selection (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const user = { id: "a1", userId: "u1", username: "ada", role: "user", theme: mobile ? "dark" : "light", language: "en" };
    const issues = Array.from({ length: 55 }, (_, index) => ({ number: index + 1, title: `Issue ${index + 1}`,
      url: `https://github.com/octo/hello/issues/${index + 1}`, state: "open", labels: ["bug"],
      author: "octocat", comments: 0, importedTaskId: null }));
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { tasks: [], sessions: [], agents: [], teams: [], nodes: [], projects: [], sandboxes: [], skills: [], notifications: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user };
      if (path.endsWith("/account/github")) body = { configured: true, connected: true, login: "octocat", manageUrl: "https://github.com/settings/installations" };
      if (path.endsWith("/tasks/github/issues")) {
        const { page: number } = route.request().postDataJSON();
        body = { repository: { owner: "octo", name: "hello", fullName: "octo/hello" }, page: number,
          hasMore: number === 1, issues: number === 1 ? issues.slice(0, 50) : issues.slice(50) };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/tasks?githubImport=1&githubConnection=connected");
    const drawer = page.getByRole("dialog", { name: "Import from GitHub" });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveCSS("opacity", "1");
    await expect(drawer.getByText("@octocat")).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Reconnect GitHub", exact: true })).toBeVisible();
    await expect(drawer.locator('input[type="password"]')).toHaveCount(0);
    await expect(drawer.getByText("GitHub is connected. You can now import issues from your selected repositories.")).toBeVisible();
    await page.screenshot({ path: `/tmp/relay-github-connection-${mobile ? "mobile" : "desktop"}.png`, fullPage: true, animations: "disabled" });
    await drawer.getByRole("textbox", { name: /^Repository\b/ }).fill("octo/hello");
    await drawer.getByRole("button", { name: "Load issues", exact: true }).click();
    await drawer.getByRole("button", { name: "Load more", exact: true }).click();
    const selectAll = drawer.getByRole("checkbox", { name: /^Select every issue not yet imported\b/ });
    await selectAll.click();
    await expect(drawer.getByText("50 of 55 selected", { exact: true })).toBeVisible();
    await selectAll.click();
    await expect(drawer.getByText("0 of 55 selected", { exact: true })).toBeVisible();
    expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
