import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SkillsPage } from "../src/components/SkillsPage";

const LABELS: Record<string, string> = {
  "skills.publish_skill": "Publish skill",
  "skills.publish_title": "Publish a skill",
  "skills.close": "Close",
  "skills.author": "Author",
  "skills.upload_bundle": "Upload bundle",
  "skills.github": "GitHub",
  "skills.skill_name": "Skill name",
  "skills.namespace": "Namespace",
  "skills.description": "Description",
  "skills.instructions": "Instructions",
  "skills.display_name": "Display name",
  "skills.manage": "Manage",
  "skills.save_details": "Save details",
  "skills.share": "Share",
  "skills.publish": "Publish",
  "skills.cancel": "Cancel",
  "skills.visibility.private": "Private",
  "skills.visibility.org": "Organization",
};
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => LABELS[key] ?? key, i18n: { language: "en" } }),
}));

const skill = {
  id: "skill-1", ownerEmployeeId: "employee-1", name: "release", slug: "release",
  displayName: "Release notes", description: "Draft concise release notes",
  visibility: "org" as const, source: "authored" as const, currentRevisionId: "rev-1",
  grantedAgentIds: [], revisions: [{ id: "rev-1", revision: 1, note: "", createdAt: "2026-09-01T00:00:00Z" }],
  files: [{ path: "SKILL.md", sha256: "a".repeat(64), bytes: 64 }],
};
const { updateSkill } = vi.hoisted(() => ({ updateSkill: vi.fn(async () => skill) }));
vi.mock("../src/api", () => ({
  createSkill: vi.fn(), importSkill: vi.fn(), deleteSkill: vi.fn(),
  reimportSkill: vi.fn(), reviseSkill: vi.fn(), updateSkill,
}));
vi.mock("../src/hooks/useSkills", () => ({
  SKILLS_QUERY_KEY: "skills",
  useSkills: () => ({ data: { skills: [{ ...skill, grantedAgentCount: 0 }] }, isLoading: false, error: null, refetch: vi.fn() }),
  useSkill: () => ({ data: skill, isLoading: false, error: null }),
}));
vi.mock("../src/hooks/useEmployeeAgents", () => ({ useEmployeeAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));

/* The drawer and the detail editor used to share one set of metadata fields:
   the publish form opened pre-filled with the selected skill, and typing in it
   rewrote the edits waiting to be saved on that skill. */
it("keeps the publish draft out of the selected skill's editor", async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SkillsPage currentUser={{ employeeId: "employee-1" } as any} />
    </QueryClientProvider>,
  );
  const editorName = () => screen.getByLabelText("Display name") as HTMLInputElement;
  const descriptions = () => screen.getAllByLabelText("Description") as HTMLTextAreaElement[];
  expect(editorName().value).toBe("Release notes");
  expect(descriptions()).toHaveLength(1);
  expect(descriptions()[0]!.value).toBe("Draft concise release notes");

  await user.click(screen.getByRole("button", { name: "Publish skill" }));
  // The editor's field stays first in the DOM; the drawer's is the second.
  const [editorDescription, draftDescription] = descriptions();
  expect((screen.getByLabelText("Skill name") as HTMLInputElement).value).toBe("");
  expect(draftDescription!.value).toBe("");
  expect(editorDescription!.value).toBe("Draft concise release notes");

  await user.type(draftDescription!, "Summarize an incident");
  expect(descriptions()[0]!.value).toBe("Draft concise release notes");

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(editorName().value).toBe("Release notes");
  expect(descriptions()[0]!.value).toBe("Draft concise release notes");
});
