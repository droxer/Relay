import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { SkillsPage } from "../src/components/SkillsPage";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import type { SkillDetail } from "../src/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("../src/hooks/useUserAgents", () => ({ useUserAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));
const api = vi.hoisted(() => ({ listSkills: vi.fn(), getSkill: vi.fn(), promoteSkillRevision: vi.fn() }));
vi.mock("../src/api", () => ({ ...api, createSkill: vi.fn(), importSkill: vi.fn(), deleteSkill: vi.fn(), reimportSkill: vi.fn(), reviseSkill: vi.fn(), updateSkill: vi.fn() }));

let skill: SkillDetail;
beforeEach(() => {
  vi.clearAllMocks();
  skill = {
    id: "skill", ownerUserId: "owner", name: "review", slug: "review", displayName: "Review",
    description: "Review code", visibility: "private", source: "upload", namespace: "",
    currentRevisionId: "v2", stableRevisionId: "v1", createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z",
    files: [], grantedAgentIds: [], assignments: [],
    revisions: [2, 1].map((revision) => ({ id: `v${revision}`, revision, bytes: 1, manifestSha256: "sha", createdAt: "2026-11-12T00:00:00Z", createdByUserId: "owner" })),
  };
  api.listSkills.mockImplementation(async () => ({ skills: [skill] }));
  api.getSkill.mockImplementation(async () => skill);
  api.promoteSkillRevision.mockImplementation(async (_id, revisionId) => {
    skill = { ...skill, stableRevisionId: revisionId };
    return skill;
  });
});

function show(userId = "owner") {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <DialogProvider><SkillsPage currentUser={{ userId } as any} skillId="skill" onSelectSkill={() => {}} /></DialogProvider>
  </QueryClientProvider>);
}

it.each(["upload", "git"] as const)("promotes a %s revision on request and refreshes stable state", async (source) => {
  skill.source = source;
  show();
  const user = userEvent.setup();
  expect(api.promoteSkillRevision).not.toHaveBeenCalled();
  await user.click(await screen.findByRole("button", { name: "skills.promote_revision_label" }));
  await waitFor(() => expect(api.promoteSkillRevision).toHaveBeenCalledWith("skill", "v2"));
  await waitFor(() => expect(screen.getByText("skills.stable_revision").closest("li")?.textContent).toContain("v2"));
});

it("shows promotion failures and allows retry without changing stable", async () => {
  api.promoteSkillRevision.mockRejectedValueOnce(new Error("revision-not-found"));
  show();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "skills.promote_revision_label" }));
  expect((await screen.findByRole("alert")).textContent).toBe("skills.errors.revision-not-found");
  expect(skill.stableRevisionId).toBe("v1");
  expect((screen.getByRole("button", { name: "skills.promote_revision_label" }) as HTMLButtonElement).disabled).toBe(false);
  await user.click(screen.getByRole("button", { name: "skills.promote_revision_label" }));
  await waitFor(() => expect(skill.stableRevisionId).toBe("v2"));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not offer promotion to another publication's viewer", async () => {
  show("viewer");
  await screen.findByRole("heading", { name: "Review" });
  expect(screen.queryByRole("button", { name: "skills.promote_revision_label" })).toBeNull();
});
