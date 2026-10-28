import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RelayApiError } from "../src/api";
import { ProjectSettingsPanel } from "../src/components/ProjectSettingsPanel";
import type { ProjectRecord } from "../src/types";

const { update, archive, unarchive, remove, getProject, confirm, startSetup } = vi.hoisted(() => ({
  update: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), remove: vi.fn(), getProject: vi.fn(), confirm: vi.fn(), startSetup: vi.fn(),
}));
vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), getProject }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  updateProjectMutation: { isPending: false, mutateAsync: update },
  archiveProjectMutation: { isPending: false, mutateAsync: archive },
  unarchiveProjectMutation: { isPending: false, mutateAsync: unarchive },
  deleteProjectMutation: { isPending: false, mutateAsync: remove },
  startProjectSetupMutation: { isPending: false, mutateAsync: startSetup },
}) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm }) }));

const project = { id: "p", version: 1, name: "Original", computerId: "node:node", members: [], leadAgentId: null, enabled: true } as ProjectRecord;
const computer = { label: "Work computer", ownership: "local" as const };
const nameInput = () => screen.getByRole("textbox", { name: "project.name" }) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole("button", { name: "project.save" }));

function renderPanel(record: ProjectRecord = project, onDeleted = vi.fn()) {
  const view = render(<ProjectSettingsPanel project={record} computer={computer} onDeleted={onDeleted} />);
  return { ...view, onDeleted, rerenderWith: (next: ProjectRecord) => view.rerender(
    <ProjectSettingsPanel project={next} computer={computer} onDeleted={onDeleted} />,
  ) };
}

beforeEach(() => {
  update.mockReset().mockResolvedValue({ project });
  archive.mockReset(); unarchive.mockReset(); remove.mockReset(); getProject.mockReset();
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

it("requires saving or discarding changes before archiving", () => {
  renderPanel();
  fireEvent.change(nameInput(), { target: { value: "Keep my edits" } });
  const button = screen.getByRole("button", { name: "project.archive" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByText("project.archive_unsaved")).toBeTruthy();
  fireEvent.click(button);
  expect(archive).not.toHaveBeenCalled();
  expect(nameInput().value).toBe("Keep my edits");
  fireEvent.click(screen.getByRole("button", { name: "unsaved.confirm" }));
  expect(button.disabled).toBe(false);
});

it("preserves a draft if another client archives the project and it is unarchived here", async () => {
  const view = renderPanel();
  fireEvent.change(nameInput(), { target: { value: "Keep my edits" } });
  view.rerenderWith({ ...project, archivedAt: "today", version: 2 });
  unarchive.mockResolvedValue({ project: { ...project, version: 3 } });
  fireEvent.click(screen.getByRole("button", { name: "project.unarchive" }));
  await waitFor(() => expect(unarchive).toHaveBeenCalled());
  await act(async () => {});
  expect(nameInput().value).toBe("Keep my edits");
});

it("locks the details of an archived project but still allows unarchiving and deleting it", () => {
  renderPanel({ ...project, archivedAt: "2026-09-01" });
  expect(screen.getByText("project.settings_archived")).toBeTruthy();
  expect(nameInput().matches(":disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "project.archive" })).toBeNull();
  expect(screen.getByRole("button", { name: "project.unarchive" }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("button", { name: "project.delete" }).hasAttribute("disabled")).toBe(false);
});

it("unarchives the current version and reopens the details for editing", async () => {
  const archived = { ...project, archivedAt: "2026-09-01", enabled: false, version: 2 };
  unarchive.mockResolvedValue({ project: { ...project, enabled: true, version: 3 } });
  renderPanel(archived);
  fireEvent.click(screen.getByRole("button", { name: "project.unarchive" }));
  await waitFor(() => expect(unarchive).toHaveBeenCalledWith({ projectId: "p", expectedVersion: 2 }));
  expect(confirm).not.toHaveBeenCalled();
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

it("hands the delete a way to open the thread that blocks it", async () => {
  remove.mockResolvedValue({ deletedProjectId: "p", workspaceCleanup: "queued" });
  const onOpenThread = vi.fn();
  render(<ProjectSettingsPanel project={project} computer={computer} onDeleted={vi.fn()} onOpenThread={onOpenThread} />);
  fireEvent.click(screen.getByRole("button", { name: "project.delete" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith({ projectId: "p", expectedVersion: 1, openThread: onOpenThread }));
});

it("stays on settings when deletion fails", async () => {
  remove.mockRejectedValue(new Error("project_execution_active"));
  const { onDeleted } = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "project.delete" }));
  await waitFor(() => expect(remove).toHaveBeenCalledOnce());
  expect(onDeleted).not.toHaveBeenCalled();
});

it("adopts a run's context suggestion into the draft and resolves it on save", async () => {
  update.mockResolvedValue({ project });
  const suggestion = { id: "r:0", text: "Pricing lives in content/pricing.json.", evidence: "Created it", threadId: "t", runId: "r", createdAt: "now" };
  renderPanel({ ...project, context: "Use Next.js.", contextSuggestions: [suggestion, { ...suggestion, id: "r:1", text: "Noise" }] });
  fireEvent.click(screen.getAllByRole("button", { name: "project.context_suggestion_adopt" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "project.context_suggestion_dismiss" }));
  expect(screen.queryByText("Noise")).toBeNull();
  save();
  await waitFor(() => expect(update).toHaveBeenCalled());
  expect(update.mock.calls[0][0].input).toMatchObject({
    context: "Use Next.js.\n- Pricing lives in content/pricing.json.",
    resolveContextSuggestions: ["r:0", "r:1"],
  });
});

it("asks the crew for a refine proposal and returns to the dashboard", async () => {
  startSetup.mockResolvedValue({ project, threadId: "t" });
  const onSetupStarted = vi.fn();
  render(<ProjectSettingsPanel project={project} computer={computer} onDeleted={vi.fn()} onSetupStarted={onSetupStarted} />);
  fireEvent.change(screen.getByRole("textbox", { name: "project.refine_note" }), { target: { value: "Too many bugs slip through" } });
  fireEvent.click(screen.getByRole("button", { name: "project.refine_start" }));
  await waitFor(() => expect(onSetupStarted).toHaveBeenCalled());
  expect(startSetup).toHaveBeenCalledWith({ projectId: "p", input: { intent: "Too many bugs slip through" } });
});

it("holds off a refine while a setup draft is open", () => {
  renderPanel({ ...project, setup: { state: "proposed", intent: "x", agentId: "a", threadId: "t", startedAt: "s" } });
  expect(screen.getAllByText("project.refine_open")).toHaveLength(2);
  expect((screen.getByRole("button", { name: "project.refine_start" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "project.plan_start" }) as HTMLButtonElement).disabled).toBe(true);
});

it("asks the lead for a plan once the project has a crew", async () => {
  startSetup.mockResolvedValue({ project, threadId: "t" });
  const onSetupStarted = vi.fn();
  const crewed = { ...project, leadAgentId: "a" } as ProjectRecord;
  render(<ProjectSettingsPanel project={crewed} computer={computer} onDeleted={vi.fn()} onSetupStarted={onSetupStarted} />);
  fireEvent.change(screen.getByRole("textbox", { name: "project.plan_note" }), { target: { value: "Plan the launch" } });
  fireEvent.click(screen.getByRole("button", { name: "project.plan_start" }));
  await waitFor(() => expect(onSetupStarted).toHaveBeenCalled());
  expect(startSetup).toHaveBeenCalledWith({ projectId: "p", input: { intent: "Plan the launch", mode: "plan" } });
});

it("holds off a plan until the project has a lead", () => {
  render(<ProjectSettingsPanel project={project} computer={computer} onDeleted={vi.fn()} />);
  expect(screen.getByText("project.plan_needs_crew")).toBeTruthy();
  expect((screen.getByRole("button", { name: "project.plan_start" }) as HTMLButtonElement).disabled).toBe(true);
});
