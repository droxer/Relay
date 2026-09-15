import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SkillsPage } from "../src/components/SkillsPage";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("../src/hooks/useEmployeeAgents", () => ({ useEmployeeAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));
const api = vi.hoisted(() => ({ listSkills: vi.fn(), getSkill: vi.fn(), deleteSkill: vi.fn() }));
vi.mock("../src/api", () => ({ ...api, createSkill: vi.fn(), importSkill: vi.fn(), reimportSkill: vi.fn(), reviseSkill: vi.fn(), updateSkill: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each([false, true])("does not reselect a deleted publication (another skill: %s)", async (hasRemaining) => {
  const makeSkill = (id: string) => ({ id, ownerEmployeeId: "employee", name: id, slug: id, displayName: id, description: id, visibility: "private", source: "upload", grantedAgentIds: [], revisions: [], files: [] });
  let inventory = [makeSkill("temporary-upload"), ...(hasRemaining ? [makeSkill("remaining-skill")] : [])];
  let deleted = false;
  api.listSkills.mockImplementation(async () => {
    // Preserve the network gap where the previous roster is still cached.
    if (deleted) await new Promise((resolve) => setTimeout(resolve, 30));
    return { skills: [...inventory] };
  });
  api.getSkill.mockImplementation(async (id: string) => {
    const skill = inventory.find((item) => item.id === id);
    if (!skill) throw new Error("skill-not-found");
    return skill;
  });
  api.deleteSkill.mockImplementation(async () => { deleted = true; inventory = inventory.filter((item) => item.id !== "temporary-upload"); });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(<QueryClientProvider client={client}><SkillsPage currentUser={{ employeeId: "employee" } as any} /></QueryClientProvider>);
  await screen.findByRole("heading", { name: "temporary-upload" });
  await user.click(screen.getByRole("button", { name: "skills.delete_skill" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "temporary-upload" })).toBeNull());
  await screen.findByRole("heading", { name: hasRemaining ? "remaining-skill" : "skills.empty_title" });
  expect(screen.queryByRole("alert")).toBeNull();
});
