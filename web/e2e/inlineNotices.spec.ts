import { expect, test } from "@playwright/test";

// Inline conversation notices must remain usable across themes, languages and input modes.
const stamp = "2026-11-06T00:00:00Z";
const agent = { id: "ada", displayName: "Ada", executorKind: "codex", defaultRole: "implementer", supervisorUserId: "u", enabled: true, availability: "ready", version: 1, skills: [], placements: [{ id: "p", agentId: "ada", computerId: "computer", daemonNodeId: "node", desiredState: "active", status: "ready" }], createdAt: stamp, updatedAt: stamp };
const said = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I drafted the launch plan and staged the first task for you to review." }] } });
const session = {
  id: "t", taskGoal: "Plan the autumn launch", projectId: "launch", ownerUserId: "u", participantAgentIds: ["ada"], participants: ["human"],
  status: "completed", phase: "done", finalOutcome: "Drafted the plan.", workOutcome: "reported_done",
  nextSteps: ["Break the design task into smaller tasks and order them by risk", "Add a deadline", "Summarize what is still open in this project before Friday's review with the whole team"],
  agentRuns: [{ id: "run-1", agent: "codex", logicalAgentId: "ada", status: "completed", startedAt: stamp, completedAt: stamp, artifactIds: [] }],
  events: [
    { id: "e1", type: "agent.started", sessionId: "t", timestamp: stamp, runId: "run-1", agent: "codex", logicalAgentId: "ada" },
    { id: "e2", type: "agent.output", sessionId: "t", timestamp: stamp, runId: "run-1", agent: "codex", stream: "stdout", text: `${said}\n` },
    { id: "e3", type: "agent.completed", sessionId: "t", timestamp: stamp, runId: "run-1", agent: "codex", status: "completed", exitCode: 0 },
  ],
  artifacts: [], decisions: [], collaborationRounds: [], createdAt: stamp, updatedAt: stamp,
  execution: { phase: "terminal", executionConfirmed: true, deletionRequested: false, canDelete: true, blockingReason: null, lastConfirmedAt: stamp, nextRecoveryAt: null },
};
const project = { id: "launch", name: "Autumn launch", ownerUserId: "u", computerId: "computer", enabled: true, members: [{ agentId: "ada", role: "planner", projectManager: true, enabled: true }], managerAgentId: "ada", managerThreadId: "t", leadAgentId: "ada", version: 1, workspaceLayout: "project", workspaceSubpath: "projects/launch", createdAt: stamp, updatedAt: stamp,
  setup: { id: "s", threadId: "t", state: "proposed", mode: "plan", proposal: { tasks: [] }, createdAt: stamp, updatedAt: stamp } };

for (const language of ["en", "zh-CN"] as const) for (const state of ["pending", "applied"] as const) for (const theme of ["light", "dark"] as const) for (const [name, size] of [["small-phone", { width: 320, height: 640 }], ["phone", { width: 390, height: 844 }], ["landscape", { width: 844, height: 390 }], ["tablet", { width: 834, height: 1400 }], ["desktop", { width: 1440, height: 1400 }]] as const) {
  test(`notices ${language} ${state} ${theme} ${name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: size, hasTouch: name !== "desktop", isMobile: name.includes("phone") || name === "landscape", serviceWorkers: "block" });
    const page = await context.newPage();
    const proposal = { id: "proposal", projectId: "launch", threadId: "t", agentId: "ada", runId: "run", state, revision: 1, createdAt: stamp, operations: [{ id: "0", kind: "create", key: "design", fields: { title: "DesignLoginWithPasskeysAndAccountRecovery".repeat(3), description: "List accepted login states.", priority: "high", assignedAgentId: "ada", dueDate: null }, after: [], afterTaskIds: [] }] };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = { sessions: [session], agents: [agent], teams: [], nodes: [], projects: [project], tasks: [], sandboxes: [], skills: [] };
      if (path.endsWith("/auth/me")) body = { authenticated: true, user: { id: "u", userId: "u", username: "Fei", role: "user", theme, language } };
      if (path.endsWith("/manager")) body = { project, manager: { agentId: "ada", agentName: "Ada", threadId: "t", toolsAvailable: true, reason: null, candidates: [] }, proposals: [proposal] };
      if (path.endsWith("/threads/t")) body = { ...session, nextSteps: language === "zh-CN" ? ["把设计任务按风险拆分并安排顺序", "添加截止日期", "总结项目中尚未完成的工作，并列出下周评审前需要确认的事项，以及每项工作的负责人和验收条件"] : session.nextSteps };
      if (path.endsWith("/projects/launch")) body = project;
      if (path.endsWith("/events")) { await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }); return; }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.addInitScript(() => localStorage.setItem("relay-web.signedIn", "1"));
    await page.goto("/threads/t");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator(".next-steps")).toBeVisible();
    await expect(page.locator(".manager-proposal")).toBeVisible();
    await expect(page.locator(".project-setup-cue")).toBeVisible();
    await expect(page.locator(".manager-proposal fieldset")).toHaveCount(state === "pending" ? 1 : 0);
    const notices = page.locator(".next-steps, .manager-proposal, .project-setup-cue");
    const overflow = await notices.evaluateAll((roots) => roots.flatMap(el => [el, ...el.querySelectorAll("*")]).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width && (rect.right > innerWidth + 1 || rect.left < -1);
    }).map(el => `${el.tagName}.${el.className}`));
    expect(overflow).toEqual([]);

    const touch = name !== "desktop";
    const controls = page.locator(".next-steps-item, .manager-actions button, .manager-field select, .project-setup-cue button, .manager-operation legend label");
    for (const control of await controls.all()) {
      const height = await control.evaluate(el => el.getBoundingClientRect().height);
      const isLabel = await control.evaluate(el => el.tagName === "LABEL");
      expect(height, await control.evaluate(el => el.outerHTML)).toBeGreaterThanOrEqual(touch ? 44 : isLabel ? 16 : 32);
    }
    if (touch) {
      const sizes = await page.locator(".manager-field input, .manager-field textarea, .manager-field select").evaluateAll(els => els.map(el => parseFloat(getComputedStyle(el).fontSize)));
      for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);
      await expect(page.locator(".next-steps-send").first()).toHaveCSS("opacity", "1");
    }

    // Composite actual theme surfaces before measuring text contrast, including
    // transparent fields. The canvas resolves CSS color-mix/modern color syntax.
    const contrast = await notices.evaluateAll(roots => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      const luminance = (rgb: Uint8ClampedArray) => [...rgb].slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      return roots.flatMap(root => [...root.querySelectorAll("h2, h3, p, button, label, select")]).map(el => {
        const parents: Element[] = []; for (let p: Element | null = el; p; p = p.parentElement) parents.unshift(p);
        ctx.clearRect(0, 0, 1, 1);
        for (const p of parents) { ctx.fillStyle = getComputedStyle(p).backgroundColor; ctx.fillRect(0, 0, 1, 1); }
        const bg = luminance(ctx.getImageData(0, 0, 1, 1).data);
        ctx.fillStyle = getComputedStyle(el).color; ctx.fillRect(0, 0, 1, 1);
        const fg = luminance(ctx.getImageData(0, 0, 1, 1).data);
        return { text: el.textContent?.slice(0, 40), ratio: (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05) };
      });
    });
    for (const sample of contrast) expect(sample.ratio, sample.text).toBeGreaterThanOrEqual(4.5);
    await page.locator(".manager-proposal").screenshot({ path: test.info().outputPath("proposal.png") });
    const suggestion = page.locator(".next-steps-item").first();
    await suggestion.focus();
    await expect(suggestion).toBeFocused();
    await expect(suggestion).not.toHaveCSS("outline-style", "none");
    await page.screenshot({ path: test.info().outputPath("notices.png"), fullPage: true });
    await context.close();
  });
}
