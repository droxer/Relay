import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SkillsPage } from "../src/components/SkillsPage";
import type { CurrentUser } from "../src/domain-types/users";
import type { SkillRecord } from "../src/domain-types/skills";
import { DialogProvider } from "../src/components/ui/DialogProvider";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => ({ "skills.group_uploads": "Uploaded" }[key] ?? key), i18n: { language: "en" } }) }));

function skill(id: string, patch: Partial<SkillRecord>): SkillRecord {
  return {
    id, ownerUserId: "user-1", namespace: "", name: id, slug: id, displayName: id, description: "",
    visibility: "private", source: "upload", sourceRef: null, currentRevisionId: "r", stableRevisionId: "r",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...patch,
  };
}
const repo = (subpath: string) => ({ source: "git" as const, sourceRef: { url: "https://github.com/acme/skills", ref: "main", subpath } });
const skills = [
  skill("tdd", repo("skills/engineering/tdd")),
  skill("triage", repo("skills/product/triage")),
  skill("review", repo("skills/engineering/review")),
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

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DialogProvider>
        <SkillsPage currentUser={{ userId: "user-1" } as CurrentUser} skillId="tdd" onSelectSkill={vi.fn()} />
      </DialogProvider>
    </QueryClientProvider>,
  );
}

const rows = (folder: string) =>
  within(screen.getByRole("list", { name: folder })).getAllByRole("button").map((row) => row.textContent?.split("skills.")[0]);

it("bands the library by each bundle's parent folder, uploads last", () => {
  renderPage();
  const bands = screen.getAllByRole("list").map((list) => list.getAttribute("aria-label"));
  expect(bands).toEqual(["skills/engineering", "skills/product", "Uploaded"]);
  expect(rows("skills/engineering")).toEqual(["review", "tdd"]);
  expect(rows("skills/product")).toEqual(["triage"]);
  expect(rows("Uploaded")).toEqual(["notes"]);
});

it("finds skills by their folder path and drops emptied bands", async () => {
  const user = userEvent.setup();
  renderPage();
  await user.type(screen.getByRole("searchbox"), "product");
  expect(screen.getAllByRole("list").map((list) => list.getAttribute("aria-label"))).toEqual(["skills/product"]);
});
