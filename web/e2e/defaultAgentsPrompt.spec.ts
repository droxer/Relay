import { test, expect, type Page } from "@playwright/test";

type Answer = { path: string; body: unknown };

/* A connecting computer asks whether to create a default agent per ready
   runtime it brought; the answer is what reaches the wire, so assert that. */
async function serveOffer(page: Page, theme: "light" | "dark"): Promise<Answer[]> {
  const answers: Answer[] = [];
  let answered = false;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = { sessions: [], agents: [], teams: [], tasks: [], nodes: [], projects: [], sandboxes: [] };
    if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "review-user", userId: "review-user", username: "review", role: "user", theme, language: "en", onboarding: { dismissedAt: new Date().toISOString() } } };
    if (path.endsWith("/agents/default-offers")) {
      body = { offers: answered ? [] : [{ computerId: "device:review:mac", computerName: "Studio Mac", executorKinds: ["claude", "codex"] }] };
    }
    if (request.method() === "POST" && path.includes("/agents/default-offers/")) {
      answers.push({ path, body: request.postDataJSON() });
      answered = true;
      body = path.endsWith("/accept") ? { agents: [{ id: "agent-1" }] } : { ok: true };
    }
    await route.fulfill({ status: path.endsWith("/accept") ? 201 : 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return answers;
}

for (const theme of ["light", "dark"] as const) {
  test(`a connected computer asks before creating its default agents (${theme})`, async ({ page }, testInfo) => {
    const answers = await serveOffer(page, theme);
    await page.goto("/threads");

    const dialog = page.getByRole("dialog", { name: "Set up agents on Studio Mac?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox")).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath(`default-agents-${theme}.png`) });

    await dialog.getByRole("checkbox", { name: "Codex" }).click();
    await dialog.getByRole("button", { name: "Create agent" }).click();

    await expect(dialog).toBeHidden();
    expect(answers).toEqual([
      { path: "/api/v1/agents/default-offers/decline", body: { computerId: "device:review:mac", executorKinds: ["codex"] } },
      { path: "/api/v1/agents/default-offers/accept", body: { computerId: "device:review:mac", executorKinds: ["claude"] } },
    ]);
  });
}

test("skip declines every offered runtime", async ({ page }) => {
  const answers = await serveOffer(page, "light");
  await page.goto("/threads");

  await page.getByRole("dialog").getByRole("button", { name: "Skip" }).click();

  await expect(page.getByRole("dialog")).toBeHidden();
  expect(answers).toEqual([
    { path: "/api/v1/agents/default-offers/decline", body: { computerId: "device:review:mac", executorKinds: ["claude", "codex"] } },
  ]);
});

test("closing the dialog answers nothing", async ({ page }) => {
  const answers = await serveOffer(page, "light");
  await page.goto("/threads");

  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.getByRole("dialog")).toBeHidden();
  expect(answers).toEqual([]);
});
