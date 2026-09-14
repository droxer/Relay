import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SkillsPage } from "../src/components/SkillsPage";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => ({ "skills.publish_first": "Publish your first skill", "skills.publish_title": "Publish a skill", "skills.close": "Close", "skills.author": "Author", "skills.upload_bundle": "Upload bundle", "skills.github": "GitHub", "skills.skill_name": "Skill name", "skills.namespace": "Namespace", "skills.description": "Description", "skills.instructions": "Instructions", "skills.publish": "Publish", "skills.cancel": "Cancel" }[key] ?? key), i18n: { language: "en" } }) }));

const { createSkill } = vi.hoisted(() => ({ createSkill: vi.fn(async (input: any) => ({ id: "new-skill", ...input })) }));
vi.mock("../src/api", () => ({ createSkill, importSkill: vi.fn(), deleteSkill: vi.fn(), reimportSkill: vi.fn(), reviseSkill: vi.fn(), updateSkill: vi.fn() }));
vi.mock("../src/hooks/useSkills", () => ({ SKILLS_QUERY_KEY: "skills", useSkills: () => ({ data: { skills: [] }, isLoading: false, error: null, refetch: vi.fn() }), useSkill: () => ({ data: null, isLoading: false, error: null }) }));
vi.mock("../src/hooks/useEmployeeAgents", () => ({ useEmployeeAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));

it("authors a valid SKILL.md bundle from the publish drawer", async () => {
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient()}><SkillsPage currentUser={{ employeeId: "employee-1" } as any} /></QueryClientProvider>);
  await user.click(screen.getByRole("button", { name: "Publish your first skill" }));
  await user.type(screen.getByLabelText("Skill name"), "release-notes");
  await user.type(screen.getByLabelText("Description"), "Draft concise release notes");
  await user.type(screen.getByLabelText("Instructions"), "Read the changelog and summarize user-facing changes.");
  await user.click(screen.getByRole("button", { name: "Publish" }));
  expect(createSkill).toHaveBeenCalledOnce();
  const input = createSkill.mock.calls[0][0];
  expect(input.source).toBe("authored");
  expect(atob(input.files[0].contentBase64)).toContain('name: "release-notes"');
  expect(atob(input.files[0].contentBase64)).toContain('description: "Draft concise release notes"');
});
