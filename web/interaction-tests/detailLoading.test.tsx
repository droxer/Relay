import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SkillsPage } from "../src/components/SkillsPage";
import { SkillPreviewDrawer } from "../src/components/SkillPreviewDrawer";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import { RelayApiError } from "../src/api-client/client";
import type { CurrentUser, SkillDetail } from "../src/types";

const { getSkill, readSkillFile } = vi.hoisted(() => ({ getSkill: vi.fn(), readSkillFile: vi.fn() }));
vi.mock("../src/api", async (load) => ({
  ...await load<Record<string, unknown>>(), getSkill, readSkillFile,
  listSkills: async () => ({ skills: [] }),
}));
vi.mock("../src/hooks/useUserAgents", () => ({ useUserAgents: () => ({ agents: [] }) }));
vi.mock("../src/hooks/useTeams", () => ({ useTeams: () => ({ teams: [] }) }));

const skill = {
  id: "skill-1", ownerUserId: "owner", displayName: "Release notes", slug: "release",
  description: "Draft release notes", source: "authored", visibility: "private",
  grantedAgentIds: [], revisions: [], files: [{ path: "SKILL.md", bytes: 42 }],
} as unknown as SkillDetail;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function mount(preview: boolean, cached = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  if (cached) client.setQueryData(["skills", skill.id], skill);
  const view = render(<QueryClientProvider client={client}><DialogProvider>
    {preview
      ? <SkillPreviewDrawer skillId={skill.id} fallbackTitle="Skill" onClose={() => {}} />
      : <SkillsPage currentUser={{ userId: "reader" } as CurrentUser} skillId={skill.id} onSelectSkill={() => {}} />}
  </DialogProvider></QueryClientProvider>);
  return { ...view, client };
}
beforeEach(() => { getSkill.mockReset(); readSkillFile.mockReset(); });

it.each([false, true])("replaces detail skeletons with fetched content (preview=%s)", async (preview) => {
  const detail = deferred<SkillDetail>();
  getSkill.mockReturnValue(detail.promise);
  readSkillFile.mockResolvedValue({ content: "Instructions", bytes: 42 });
  const view = mount(preview);
  const loading = screen.getByText("skills.loading_detail").closest('[role="status"]')!;
  expect(loading.textContent).toBe("skills.loading_detail");
  expect(loading.querySelector('[aria-hidden="true"] .list-skeleton-bar')).toBeTruthy();
  await act(async () => { detail.resolve(skill); });
  expect(await screen.findByText("Draft release notes")).toBeTruthy();
  await waitFor(() => expect(view.container.querySelector(".detail-skeleton")).toBeNull());
  view.unmount(); view.client.clear();
});

it("keeps the preview header while file text loads, then shows its contents", async () => {
  getSkill.mockResolvedValue(skill);
  const file = deferred<{ content: string; bytes: number }>();
  readSkillFile.mockReturnValue(file.promise);
  const view = mount(true);
  expect(await screen.findByText("skills.preview_loading")).toBeTruthy();
  expect(screen.getByText("Release notes")).toBeTruthy();
  expect(view.container.querySelector(".detail-skeleton--file")).toBeTruthy();
  await act(async () => { file.resolve({ content: "Instructions", bytes: 42 }); });
  expect(await screen.findByText("Instructions")).toBeTruthy();
  expect(view.container.querySelector(".detail-skeleton")).toBeNull();
  view.unmount(); view.client.clear();
});

it.each([false, true])("keeps cached details visible during a background refresh (preview=%s)", async (preview) => {
  getSkill.mockReturnValue(new Promise(() => {}));
  readSkillFile.mockResolvedValue({ content: "Instructions", bytes: 42 });
  const view = mount(preview, true);
  await waitFor(() => expect(getSkill).toHaveBeenCalled());
  expect(screen.getByText("Draft release notes")).toBeTruthy();
  expect(view.container.querySelector(".detail-skeleton--skill, .detail-skeleton--preview")).toBeNull();
  view.unmount(); view.client.clear();
});

it.each([false, true])("shows a detail error rather than a perpetual skeleton (preview=%s)", async (preview) => {
  getSkill.mockRejectedValue(new RelayApiError("not-found", 404));
  const view = mount(preview);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(view.container.querySelector(".detail-skeleton")).toBeNull();
  if (!preview) expect(screen.getByText("skills.not_found")).toBeTruthy();
  view.unmount(); view.client.clear();
});

it("keeps file errors readable after file loading fails", async () => {
  getSkill.mockResolvedValue(skill);
  readSkillFile.mockRejectedValue(new Error("unavailable"));
  const view = mount(true);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("Release notes")).toBeTruthy();
  expect(view.container.querySelector(".detail-skeleton")).toBeNull();
  view.unmount(); view.client.clear();
});
