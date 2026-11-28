import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SkillsPage } from "../src/components/SkillsPage";
import type { CurrentUser } from "../src/domain-types/users";
import type { SkillRecord } from "../src/domain-types/skills";
import { DialogProvider } from "../src/components/ui/DialogProvider";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => ({ "skills.group_ungrouped": "Ungrouped" }[key] ?? key), i18n: { language: "en" } }) }));

function skill(id: string, patch: Partial<SkillRecord>): SkillRecord {
  return {
    id, ownerUserId: "user-1", namespace: "", name: id, slug: id, displayName: id, description: "",
    visibility: "private", source: "upload", sourceRef: null, currentRevisionId: "r", stableRevisionId: "r",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...patch,
  };
}
function imported(namespace: string, subpath: string): Partial<SkillRecord> {
  return { namespace, source: "git", sourceRef: { url: `https://github.com/acme/${namespace}`, ref: "main", subpath } };
}
const skills = [
  skill("architect", imported("pstack", "skills/architect")),
  skill("arena", imported("pstack", "skills/product/arena")),
  skill("writing-for-agents", imported("matt-pocock-skills", "skills/productivity/writing-for-agents")),
  skill("wait-what", imported("matt-pocock-skills", "skills/engineering/wait-what")),
  skill("notes", {}),
];
vi.mock("../src/api", () => ({ createSkill: vi.fn(), importSkill: vi.fn(), deleteSkill: vi.fn(), reimportSkill: vi.fn(), reviseSkill: vi.fn(), updateSkill: vi.fn() }));
vi.mock("../src/hooks/useSkills", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/hooks/useSkills")>(),
  useSkills: () => ({ data: { skills }, isLoading: false, error: null, refetch: vi.fn() }),
  useSkill: () => ({ data: null, isLoading: false, error: null }),
}));
vi.mock("../src/hooks/useUserAgents", () => ({ useUserAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));

function renderPage(skillId = "arena") {
  const currentUser = { userId: "user-1" } as CurrentUser;
  const queryClient = new QueryClient();
  const onSelectSkill = vi.fn();
  const tree = (id: string) => (
    <QueryClientProvider client={queryClient}>
      <DialogProvider>
        <SkillsPage currentUser={currentUser} skillId={id} onSelectSkill={onSelectSkill} />
      </DialogProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(tree(skillId));
  return { onSelectSkill, navigate: (id: string) => rerender(tree(id)) };
}

const rows = (group: string) =>
  within(screen.getByRole("list", { name: group })).getAllByRole("button").map((row) => row.textContent?.split("skills.")[0]);

it("opens the linked Skill's group and lets the reader toggle other groups by keyboard", async () => {
  const user = userEvent.setup();
  const { onSelectSkill, navigate } = renderPage();
  expect(rows("pstack")).toEqual(["architect", "arena"]);
  expect(screen.getByRole("button", { name: /^arena / }).getAttribute("aria-current")).toBe("page");
  const group = screen.getByRole("button", { name: /matt-pocock-skills 2/ });
  expect(group.getAttribute("aria-expanded")).toBe("false");
  group.focus();
  await user.keyboard("{Enter}");
  expect(rows("matt-pocock-skills")).toEqual(["wait-what", "writing-for-agents"]);
  await user.click(screen.getByRole("button", { name: /^wait-what / }));
  expect(onSelectSkill).toHaveBeenCalledWith("wait-what");
  group.focus();
  await user.keyboard(" ");
  expect(screen.queryByRole("list", { name: "matt-pocock-skills" })).toBeNull();
  navigate("wait-what");
  expect(group.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: /^wait-what / }).getAttribute("aria-current")).toBe("page");
  expect(screen.getAllByRole("heading", { level: 3 }).at(-1)?.textContent).toContain("Ungrouped");
});

it("shows all Skills for a group match, filters item matches and restores folding after search", async () => {
  const user = userEvent.setup();
  renderPage();
  await user.click(screen.getByRole("button", { name: /pstack 2/ }));
  const search = screen.getByRole("searchbox");
  await user.type(search, "PSTACK");
  expect(rows("pstack")).toEqual(["architect", "arena"]);
  expect(screen.getAllByRole("list")).toHaveLength(1);
  await user.clear(search);
  await user.type(search, "engineering/wait");
  expect(rows("matt-pocock-skills")).toEqual(["wait-what"]);
  expect(screen.getAllByRole("list")).toHaveLength(1);
  await user.clear(search);
  expect(screen.queryByRole("list", { name: "pstack" })).toBeNull();
  expect(screen.queryByRole("list", { name: "matt-pocock-skills" })).toBeNull();
});
