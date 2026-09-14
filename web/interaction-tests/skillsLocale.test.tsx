import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import en from "../src/i18n/locales/en/translation.json";
import zhCN from "../src/i18n/locales/zh-CN/translation.json";
import zhTW from "../src/i18n/locales/zh-TW/translation.json";
import { SkillsPage } from "../src/components/SkillsPage";
import { ShareSkillDrawer } from "../src/components/ShareSkillDrawer";
import { projectMessages } from "../src/lib/projectMessages";

vi.mock("react-i18next", async (load) => load());
vi.mock("../src/hooks/useSkills", () => ({ SKILLS_QUERY_KEY: "skills", useSkills: () => ({ data: { skills: [] }, isLoading: false, error: null, refetch: vi.fn() }), useSkill: () => ({ data: null, isLoading: false, error: null }) }));
vi.mock("../src/hooks/useEmployeeAgents", () => ({ EMPLOYEE_AGENTS_QUERY_KEY: "employee-agents", useEmployeeAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));
vi.mock("../src/api", () => ({ createSkill: vi.fn(), deleteSkill: vi.fn(), importSkill: vi.fn(), reimportSkill: vi.fn(), reviseSkill: vi.fn(), updateSkill: vi.fn(), grantSkill: vi.fn(), revokeSkill: vi.fn() }));

async function locale(language: "zh-CN" | "zh-TW") {
  const instance = createInstance();
  await instance.init({ lng: language, fallbackLng: false, interpolation: { escapeValue: false }, resources: { "zh-CN": { translation: zhCN }, "zh-TW": { translation: zhTW } } });
  return instance;
}
function providers(instance: Awaited<ReturnType<typeof locale>>, child: ReactNode) {
  return <I18nextProvider i18n={instance}><QueryClientProvider client={new QueryClient()}>{child}</QueryClientProvider></I18nextProvider>;
}

it.each([
  ["zh-CN" as const, "技能库还是空的", "发布第一个技能"],
  ["zh-TW" as const, "技能庫仍是空的", "發佈第一個技能"],
])("renders the %s library workflow from the real locale resource", async (language, emptyTitle, publish) => {
  const instance = await locale(language);
  render(providers(instance, <SkillsPage currentUser={{ employeeId: "employee-1" } as any} />));
  expect(screen.getByRole("heading", { name: emptyTitle })).toBeTruthy();
  expect(screen.getByRole("button", { name: publish })).toBeTruthy();
  expect(screen.queryByText("Your skills library is empty")).toBeNull();
});

it("interpolates the Traditional Chinese team and selected-agent counts", async () => {
  const instance = await locale("zh-TW");
  const skill = { id: "skill-1", displayName: "Release notes", grantedAgentIds: [], files: [], revisions: [] } as any;
  const agents = [{ id: "agent-1", displayName: "Codex reviewer", executorKind: "codex", enabled: true }] as any;
  const teams = [{ id: "team-1", name: "Launch team", memberAgentIds: ["agent-1"] }] as any;
  render(providers(instance, <ShareSkillDrawer skill={skill} agents={agents} teams={teams} onClose={vi.fn()} />));
  expect(screen.getByRole("button", { name: "Launch team · 1 位成員" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "分享給 0 個智慧體" })).toBeTruthy();
});

it.each([
  "zh-CN" as const,
  "zh-TW" as const,
])("localizes delivery failures in %s while retaining the skill identifier", async (language) => {
  const instance = await locale(language);
  const session = {
    id: "thread-1", taskGoal: "ship", createdAt: "2026-09-14T00:00:00Z",
    events: [{ id: "notice-1", type: "system.notice", sessionId: "thread-1",
      timestamp: "2026-09-14T00:00:01Z", runId: "run-1", agent: "claude",
      text: "Some granted skills were unavailable.", reason: "skills-skipped",
      skillsSkipped: [{ skillId: "skill-1", slug: "team/review", reason: "daemon-unsupported" }],
    }],
    agentRuns: [], artifacts: [], decisions: [], collaborationRounds: [], status: "running",
  } as any;
  const notice = projectMessages(session, instance.t).find((message) => message.id === "notice-1");
  expect(notice).toMatchObject({
    detail: `team/review: ${instance.t("skills.skip_reason.daemon-unsupported")}`,
  });
  expect(notice?.detail).not.toContain("daemon-unsupported");
});

/* `skills.bytes` used to be a single form fed a pre-formatted string as
   i18next's `count`, which selects the plural. Both halves stay explicit: a
   numeric `count` chooses the form, `value` carries the localized digits. */
it.each([
  ["en" as const, en, "1 byte", "1,024 bytes"],
  ["zh-CN" as const, zhCN, "1 字节", "1,024 字节"],
  ["zh-TW" as const, zhTW, "1 位元組", "1,024 位元組"],
])("pluralizes the %s bundle file size on a numeric count", async (language, resource, one, many) => {
  const instance = createInstance();
  await instance.init({
    lng: language, fallbackLng: false, interpolation: { escapeValue: false },
    resources: { [language]: { translation: resource } },
  });
  const render = (bytes: number) =>
    instance.t("skills.bytes", { count: bytes, value: bytes.toLocaleString("en-US") });
  expect(render(1)).toBe(one);
  expect(render(1024)).toBe(many);
});
