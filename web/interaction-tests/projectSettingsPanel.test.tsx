import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RelayApiError } from "../src/api";
import { ProjectSettingsPanel } from "../src/components/ProjectSettingsPanel";
import type { ProjectRecord } from "../src/types";

const { update, archive, remove, getProject, confirm } = vi.hoisted(() => ({
  update: vi.fn(), archive: vi.fn(), remove: vi.fn(), getProject: vi.fn(), confirm: vi.fn(),
}));
vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), getProject }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  updateProjectMutation: { isPending: false, mutateAsync: update },
  archiveProjectMutation: { isPending: false, mutateAsync: archive },
  deleteProjectMutation: { isPending: false, mutateAsync: remove },
}) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm }) }));

const project = { id: "p", version: 1, name: "Original", computerId: "node:node", members: [], leadAgentId: null, enabled: true } as ProjectRecord;
const nameInput = () => screen.getByRole("textbox", { name: "project.name" }) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole("button", { name: "project.save" }));

function renderPanel(record: ProjectRecord = project, onDeleted = vi.fn()) {
  const view = render(<ProjectSettingsPanel project={record} computerLabel="Work computer" onDeleted={onDeleted} />);
  return { ...view, onDeleted, rerenderWith: (next: ProjectRecord) => view.rerender(
    <ProjectSettingsPanel project={next} computerLabel="Work computer" onDeleted={onDeleted} />,
  ) };
}

beforeEach(() => {
  update.mockReset().mockResolvedValue({ project });
  archive.mockReset(); remove.mockReset(); getProject.mockReset();
  confirm.mockReset().mockResolvedValue(true);
});

it("shows the fixed computer and keeps save idle until something changes", () => {
  renderPanel();
  expect(screen.getByText("Work computer")).toBeTruthy();
  expect(screen.getByRole("button", { name: "project.save" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(nameInput(), { target: { value: "Renamed" } });
  expect(screen.getByRole("button", { name: "project.save" }).hasAttribute("disabled")).toBe(false);
});

it("preserves the name draft and its base revision when polling advances the project", async () => {
  const view = renderPanel();
  fireEvent.change(nameInput(), { target: { value: "Unsaved" } });
  view.rerenderWith({ ...project, name: "Concurrent rename", version: 2 });
  expect(nameInput().value).toBe("Unsaved");
  save();
  await waitFor(() => expect(update).toHaveBeenCalledWith({ projectId: "p", input: { name: "Unsaved", expectedVersion: 1 } }));
});

it("adopts a newer project while nothing is being edited", () => {
  const view = renderPanel();
  view.rerenderWith({ ...project, name: "Latest", version: 2 });
  expect(nameInput().value).toBe("Latest");
});

it("discards a draft back to the saved project", () => {
  renderPanel();
  fireEvent.change(nameInput(), { target: { value: "Throwaway" } });
  fireEvent.click(screen.getByRole("button", { name: "unsaved.confirm" }));
  expect(nameInput().value).toBe("Original");
});

it("validates an empty name without saving", () => {
  renderPanel();
  fireEvent.change(nameInput(), { target: { value: "   " } });
  save();
  expect(screen.getByRole("alert").textContent).toBe("project.name_required");
  expect(update).not.toHaveBeenCalled();
});

it("saves an edited description and leaves an untouched one out of a rename", async () => {
  renderPanel({ ...project, description: "Old brief" });
  const description = screen.getByRole("textbox", { name: /^project\.description/ }) as HTMLTextAreaElement;
  expect(description.value).toBe("Old brief");
  fireEvent.change(nameInput(), { target: { value: "Renamed" } });
  save();
  await waitFor(() => expect(update).toHaveBeenCalledWith({ projectId: "p", input: { name: "Renamed", expectedVersion: 1 } }));
  update.mockClear();
  fireEvent.change(description, { target: { value: "  Ship GA.  " } });
  save();
  await waitFor(() => expect(update).toHaveBeenCalledWith({
    projectId: "p", input: { name: "Original", description: "Ship GA.", expectedVersion: 1 },
  }));
});

it("offers a confirmed retry after a stale rename", async () => {
  update.mockRejectedValueOnce(new RelayApiError("project_version_conflict", 409, "project_version_conflict"));
  getProject.mockResolvedValue({ project: { ...project, name: "Their name", version: 2 } });
  renderPanel();
  fireEvent.change(nameInput(), { target: { value: "My name" } });
  save();
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(confirm.mock.calls[0][0].message).toContain("Their name");
  expect(update.mock.calls[1][0].input).toEqual({ name: "My name", expectedVersion: 2 });
});

it.each(["network", "conflict", "closed"])("keeps the draft if conflict recovery fails: %s", async (failure) => {
  const conflict = new RelayApiError("project_version_conflict", 409, "project_version_conflict");
  update.mockRejectedValueOnce(conflict);
  if (failure === "network") getProject.mockRejectedValue(new Error("Network unavailable"));
  else getProject.mockResolvedValue({ project: { ...project, version: 2, enabled: failure !== "closed" } });
  if (failure === "conflict") update.mockRejectedValueOnce(conflict);
  renderPanel();
  fireEvent.change(nameInput(), { target: { value: "Keep my draft" } });
  save();
  await screen.findByRole("alert");
  expect(update).toHaveBeenCalledTimes(failure === "conflict" ? 2 : 1);
  expect(nameInput().value).toBe("Keep my draft");
});

it("reports an ordinary save error without fetching or retrying", async () => {
  update.mockRejectedValue(new RelayApiError("project_name_taken", 409, "project_name_taken"));
  renderPanel();
  fireEvent.change(nameInput(), { target: { value: "Taken" } });
  save();
  expect((await screen.findByRole("alert")).textContent).toBe("project_name_taken");
  expect(getProject).not.toHaveBeenCalled();
});

it("archives a project only after confirmation", async () => {
  archive.mockResolvedValue({ project: { ...project, archivedAt: "today", version: 2 } });
  renderPanel();
  confirm.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "project.archive" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(archive).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "project.archive" }));
  await waitFor(() => expect(archive).toHaveBeenCalledWith({ projectId: "p", expectedVersion: 1 }));
});

it("locks the details of an archived project but still allows deleting it", () => {
  renderPanel({ ...project, archivedAt: "2026-09-01" });
  expect(screen.getByText("project.settings_archived")).toBeTruthy();
  expect(nameInput().matches(":disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "project.archive" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "project.delete" }).hasAttribute("disabled")).toBe(false);
});

it("does not delete when the user cancels the destructive confirmation", async () => {
  confirm.mockResolvedValue(false);
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "project.delete" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(confirm.mock.calls[0][0].message).toBe("project.delete_confirm_message");
  expect(remove).not.toHaveBeenCalled();
});

it("deletes the current version and leaves the project after confirmation", async () => {
  remove.mockResolvedValue({ deletedProjectId: "p", workspaceCleanup: "queued" });
  const { onDeleted } = renderPanel({ ...project, version: 3 });
  fireEvent.click(screen.getByRole("button", { name: "project.delete" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  expect(remove).toHaveBeenCalledWith({ projectId: "p", expectedVersion: 3 });
});

it("stays on settings when deletion fails", async () => {
  remove.mockRejectedValue(new Error("project_execution_active"));
  const { onDeleted } = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "project.delete" }));
  await waitFor(() => expect(remove).toHaveBeenCalledOnce());
  expect(onDeleted).not.toHaveBeenCalled();
});
