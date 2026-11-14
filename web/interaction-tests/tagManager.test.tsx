import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { TagsSection } from "../src/components/settings/TagsSection";
import { TaskTagsField } from "../src/components/task-board/TaskTagsField";
import * as api from "../src/api-client/tags";
import { RelayApiError } from "../src/api-client/client";

vi.mock("../src/api-client/tags", () => ({ listTags: vi.fn(), createTag: vi.fn(), previewTagOperation: vi.fn(), applyTagOperation: vi.fn() }));
const entries = [{ name: "Bug", taskCount: 3, automationCount: 1, saved: true }, { name: "Unused", taskCount: 0, automationCount: 0, saved: true }];
const preview = { operation: { operation: "delete" as const, name: "Bug" }, previewToken: "token", affected: { taskCount: 3, automationCount: 1, items: [], itemsTruncated: false }, excluded: { taskCount: 1, automationCount: 0, items: [{ id: "locked", title: "Locked task", reason: "project_not_owned", tagsBefore: ["Bug"], tagsAfter: [], number: null, isRoutine: false }], itemsTruncated: false }, catalog: { removes: ["Bug"], saves: null } };
beforeEach(() => {
  vi.mocked(api.listTags).mockReset().mockResolvedValue({ tags: entries, total: 2 });
  vi.mocked(api.createTag).mockReset().mockResolvedValue({ tag: { name: "New", taskCount: 0, automationCount: 0, saved: true } });
  vi.mocked(api.previewTagOperation).mockReset().mockResolvedValue(preview);
  vi.mocked(api.applyTagOperation).mockReset().mockResolvedValue({ operation: { operation: "delete", name: "Bug" }, updated: { taskCount: 3, automationCount: 1 }, excluded: { taskCount: 1, automationCount: 0 }, tags: [entries[1]] });
});
function mount(element = <TagsSection />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return client;
}
async function edit(action: string) {
  const badge = await screen.findByText("Bug");
  fireEvent.click(within(badge.closest("li")!).getByRole("button", { name: `tags.manager.${action}` }));
}
it("searches the complete catalog and creates an unused tag", async () => {
  mount();
  await screen.findByText("Unused");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unused" } });
  expect(screen.queryByText("Bug")).toBeNull();
  fireEvent.change(screen.getByLabelText("tags.manager.new_name"), { target: { value: "New" } });
  fireEvent.click(screen.getByRole("button", { name: "tags.manager.create" }));
  await waitFor(() => expect(api.createTag).toHaveBeenCalledWith("New"));
});
it("previews exclusions and applies only after confirmation, refreshing work caches", async () => {
  const client = mount();
  client.setQueryData(["relay", "tasks"], []);
  client.setQueryData(["task-record", "1"], {});
  await edit("delete");
  fireEvent.click(screen.getByRole("button", { name: "tags.manager.preview" }));
  await screen.findByText(/^Locked task/);
  expect(screen.getByText("tags.manager.reasons.project_not_owned")).toBeTruthy();
  expect(api.applyTagOperation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "tags.manager.confirm" }));
  await waitFor(() => expect(api.applyTagOperation).toHaveBeenCalledWith({ operation: "delete", name: "Bug" }, "token"));
  await waitFor(() => expect(screen.queryByText("Bug")).toBeNull());
  expect(client.getQueryState(["relay", "tasks"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["task-record", "1"])?.isInvalidated).toBe(true);
});
it("offers an explicit merge on rename collision", async () => {
  vi.mocked(api.previewTagOperation).mockRejectedValueOnce(new RelayApiError("tag_exists", 409, "tag_exists"));
  mount(); await edit("rename");
  fireEvent.change(screen.getByLabelText("tags.manager.target_name"), { target: { value: "Unused" } });
  fireEvent.click(screen.getByRole("button", { name: "tags.manager.preview" }));
  fireEvent.click(await screen.findByRole("button", { name: "tags.manager.offer_merge" }));
  fireEvent.click(screen.getByRole("button", { name: "tags.manager.preview" }));
  await waitFor(() => expect(api.previewTagOperation).toHaveBeenLastCalledWith({ operation: "merge", sources: ["Bug"], target: "Unused" }));
});
it("requires a fresh preview after stale apply", async () => {
  vi.mocked(api.applyTagOperation).mockRejectedValueOnce(new RelayApiError("tag_preview_stale", 409, "tag_preview_stale"));
  mount(); await edit("delete");
  fireEvent.click(screen.getByRole("button", { name: "tags.manager.preview" }));
  fireEvent.click(await screen.findByRole("button", { name: "tags.manager.confirm" }));
  await screen.findByText("tags.manager.error.tag_preview_stale");
  expect(screen.queryByRole("button", { name: "tags.manager.confirm" })).toBeNull();
  expect(screen.getByRole("button", { name: "tags.manager.preview" })).toBeTruthy();
});
it("offers saved unused names in task pickers", async () => {
  const { container } = render(<QueryClientProvider client={new QueryClient()}><TaskTagsField tags={[]} name="tags" suggestions={["Bug"]} onChange={vi.fn()} /></QueryClientProvider>);
  await waitFor(() => expect(container.querySelector('option[value="Unused"]')).toBeTruthy());
});
it("recovers from a catalog load failure", async () => {
  vi.mocked(api.listTags).mockRejectedValueOnce(new Error("offline"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "tags.manager.retry" }));
  expect(await screen.findByText("Unused")).toBeTruthy();
});
