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
  "skills.visibility_label": "Visibility",
  "skills.optional": "optional",
  "skills.revision_note": "Revision note",
  "skills.new_bundle": "New bundle",
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
  const editorName = () => screen.getByLabelText(/^Display name/) as HTMLInputElement;
  const descriptions = () => screen.getAllByLabelText(/^Description/) as HTMLTextAreaElement[];
  expect(editorName().value).toBe("Release notes");
  expect(descriptions()).toHaveLength(1);
  expect(descriptions()[0]!.value).toBe("Draft concise release notes");

  /* The create affordance is the rails' shared ghost plus, named by its
     tooltip; query it by the class every roster header uses. */
  await user.click(document.querySelector(".page-header-icon-action") as HTMLElement);
  // Bundle metadata comes from SKILL.md, so only the editor has a description.
  const [editorDescription] = descriptions();
  expect((screen.getByLabelText(/^Skill name/) as HTMLInputElement).value).toBe("");
  expect(descriptions()).toHaveLength(1);
  expect(editorDescription!.value).toBe("Draft concise release notes");

  await user.type(screen.getByLabelText(/^Skill name/), "incident-summary");
  expect(descriptions()[0]!.value).toBe("Draft concise release notes");

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(editorName().value).toBe("Release notes");
  expect(descriptions()[0]!.value).toBe("Draft concise release notes");
});

/* The editor's fields carry the same required grammar as the publish drawer,
   and Save cannot fire on a record stripped of the two fields it needs. */
it("marks the editor's required fields and gates Save on them", async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SkillsPage currentUser={{ employeeId: "employee-1" } as any} />
    </QueryClientProvider>,
  );
  const field = (label: string) =>
    screen.getByLabelText(new RegExp(`^${label}`)).closest('[data-slot="field"]') as HTMLElement;
  expect(field("Display name").textContent).toContain("*");
  expect(field("Description").textContent).toContain("*");
  expect(field("Revision note").textContent).toContain("optional");
  expect(field("Revision note").textContent).not.toContain("*");

  const save = () => screen.getByRole("button", { name: "Save details" }) as HTMLButtonElement;
  // Nothing to save at rest: an enabled Save here was a live cobalt button
  // beside "Share" with no work to do.
  expect(save().disabled).toBe(true);
  // A required field emptied cannot be saved either.
  await user.clear(screen.getByLabelText(/^Display name/));
  expect(save().disabled).toBe(true);
  // Typed back to the saved value is no change at all.
  await user.type(screen.getByLabelText(/^Display name/), "Release notes");
  expect(save().disabled).toBe(true);
  // A real, valid edit is what Save is for.
  await user.type(screen.getByLabelText(/^Display name/), " v2");
  expect(save().disabled).toBe(false);
});
