import { expect, test } from "@playwright/test";

const stamp = "2026-09-01T00:00:00.000Z";
const USER = { id: "review-user", userId: "review-user", username: "review", role: "user", theme: "light", language: "en" };
const project = {
  id: "proj-1", name: "Relay product development", ownerUserId: USER.id, computerId: "c-1",
  enabled: true, members: [], leadAgentId: null, version: 1,
  workspaceLayout: "project", workspaceSubpath: "projects/relay", createdAt: stamp, updatedAt: stamp,
};
const entries = ["docs", "src", "README.md", "quarterly-planning-notes-with-a-long-name.md", "package.json", "logo.svg"].map((name) => ({
  name, path: name, kind: name.includes(".") ? "file" : "directory", bytes: 1200, updatedAt: stamp,
}));
const readme = `# Relay product development\n\nA long paragraph that should wrap nicely on a phone screen and not overflow the pane at all, even with long words like supercalifragilisticexpialidocious.\n\n| Column | Another column | Third |\n| --- | --- | --- |\n| a | b | c |\n\n\`\`\`ts\nexport const SOMETHING_VERY_LONG_IDENTIFIER = computeTheThing(withArguments, andMoreArguments, andEvenMore);\n\`\`\`\n`;

for (const [label, width, height, touch] of [["small", 320, 640, true], ["phone", 390, 844, true], ["landscape", 844, 390, true], ["tablet", 820, 1180, true], ["compact", 1024, 768, false], ["laptop", 1280, 800, false], ["desktop", 1440, 900, false], ["wide", 2560, 1440, false]] as const) {
  test(`project file preview fits ${label}`, async ({ browser }, info) => {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let body: unknown = { sessions: [], agents: [], teams: [], tasks: [], nodes: [], projects: [project], sandboxes: [], skills: [] };
      if (url.pathname.endsWith("/auth/me")) body = { authenticated: true, user: USER };
      if (url.pathname.endsWith("/projects/proj-1")) body = project;
      if (url.pathname.endsWith("/workspace/files")) body = { projectId: "proj-1", scope: "shared", source: "live", nodeId: "node-abcdef123456", path: "", exists: true, entries, generatedAt: stamp };
      if (url.pathname.endsWith("/workspace/file")) body = { projectId: "proj-1", scope: "shared", source: "live", nodeId: "node-abcdef123456", path: "README.md", exists: true, isBinary: false, bytes: readme.length, content: readme + "\n\n" + "Long document paragraph.\n\n".repeat(100), truncated: false, limitBytes: 1000000, generatedAt: stamp };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("/projects/proj-1?tab=workspace");
    await page.getByRole("button").filter({ hasText: "README.md" }).click();
    const preview = page.locator(".workspace-pane-preview");
    await expect(preview.locator(".doc-prose")).toBeVisible();
    const browse = page.locator(".workspace-pane-browse");
    if (await page.locator(".workspace-body").evaluate(el => el.clientWidth <= 768)) await expect(browse).toBeHidden();
    else await expect(browse).toBeVisible();
    const heading = preview.getByRole("heading", { name: "README.md", exact: true });
    expect(await heading.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const close = preview.getByRole("button", { name: "Close preview", exact: true });
    const closeBox = await close.boundingBox();
    expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(width);
    expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(height);
    if (touch) {
      expect(closeBox!.width).toBeGreaterThanOrEqual(44);
      expect(closeBox!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const scroller = preview.locator(".artifact-viewer-body");
    // The document keeps at least half the screen, even on a landscape phone.
    expect((await scroller.boundingBox())!.height).toBeGreaterThanOrEqual(height / 2);
    expect(await scroller.evaluate(el => { el.scrollTop = 200; return el.scrollTop > 0; })).toBe(true);
    await preview.getByRole("button", { name: "Source", exact: true }).click();
    await expect(preview.locator(".code-view")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${label}-source.png`) });
    await preview.getByRole("button", { name: "Preview", exact: true }).click();
    await page.screenshot({ path: info.outputPath(`${label}-preview.png`) });
    await close.click();
    await expect(browse).toBeVisible();
    await expect(preview).toHaveCount(0);
    await context.close();
  });
}
