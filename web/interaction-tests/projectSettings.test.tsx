import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectDrawer } from "../src/components/ProjectDrawer";
import type { DaemonNodeMonitorRecord, ProjectRecord } from "../src/types";

import { RelayApiError } from "../src/api";
const { update, create, archive, getProject, confirm } = vi.hoisted(() => ({ update: vi.fn(), create: vi.fn(), archive: vi.fn(), getProject: vi.fn(), confirm: vi.fn() }));
vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), getProject }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  updateProjectMutation: { isPending: false, mutateAsync: update },
  createProjectMutation: { isPending: false, mutateAsync: create },
  archiveProjectMutation: { isPending: false, mutateAsync: archive },
}) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm }) }));
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children, open }: any) => open ? children : null }));
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange }: any) => <select aria-label="project.computer" value={value} onChange={(event) => onValueChange(event.target.value)}><option value="">Choose</option><option value="node">node</option></select>,
  SelectContent: () => null, SelectItem: () => null, SelectTrigger: () => null, SelectValue: () => null,
}));
const project = { id: "p", version: 1, name: "Original", computerId: "node:node", members: [], leadAgentId: null, enabled: true } as ProjectRecord;
const computers = [{ id: "node", capabilities: ["project-workspaces"] }] as DaemonNodeMonitorRecord[];
beforeEach(() => { update.mockReset().mockResolvedValue({ project }); create.mockReset(); archive.mockReset(); getProject.mockReset(); confirm.mockReset().mockResolvedValue(true); });

it("preserves the name draft and its base revision when polling advances the project", async () => {
  const props = { open: true, project, computers, onClose: vi.fn(), onSaved: vi.fn() };
  const view = render(<ProjectDrawer {...props} />);
  const input = screen.getByRole("textbox", { name: "project.name" });
  fireEvent.change(input, { target: { value: "Unsaved" } });
  view.rerender(<ProjectDrawer {...props} project={{ ...project, name: "Concurrent rename", version: 2 }} />);
  expect((input as HTMLInputElement).value).toBe("Unsaved");
  fireEvent.click(screen.getByRole("button", { name: "project.save" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ projectId: "p", input: { name: "Unsaved", expectedVersion: 1 } }));
});

it("loads the current project when reopening settings", () => {
  const props = { open: true, project, computers, onClose: vi.fn(), onSaved: vi.fn() };
  const view = render(<ProjectDrawer {...props} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsaved" } });
  view.rerender(<ProjectDrawer {...props} open={false} />);
  view.rerender(<ProjectDrawer {...props} project={{ ...project, name: "Latest", version: 2 }} />);
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Latest");
});

it("renames an existing project when its runtime computer is absent", async () => {
  render(<ProjectDrawer open project={project} computers={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "project.name" }), { target: { value: "Renamed offline" } });
  fireEvent.click(screen.getByRole("button", { name: "project.save" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ projectId: "p", input: { name: "Renamed offline", expectedVersion: 1 } }));
});

it("still requires a computer to create a project", () => {
  render(<ProjectDrawer open computers={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "project.name" }), { target: { value: "New project" } });
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("project.computer_required");
});

it("offers a confirmed retry after a stale rename", async () => {
  update.mockRejectedValueOnce(new RelayApiError("project_version_conflict", 409, "project_version_conflict"));
  getProject.mockResolvedValue({ project: { ...project, name: "Their name", version: 2 } });
  render(<ProjectDrawer open project={project} computers={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "My name" } });
  fireEvent.click(screen.getByRole("button", { name: "project.save" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(confirm.mock.calls[0][0].message).toContain("Their name");
  expect(update.mock.calls[1][0].input).toEqual({ name: "My name", expectedVersion: 2 });
});

it("creates a project on the selected compatible computer", async () => {
  const onSaved = vi.fn();
  create.mockResolvedValue({ project });
  render(<ProjectDrawer open computers={computers} onClose={vi.fn()} onSaved={onSaved} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "New project" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "node" } });
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "New project", daemonNodeId: "node", leadAgentId: null, members: [] }));
  expect(onSaved).toHaveBeenCalledWith(project);
});

it("archives a project only after confirmation", async () => {
  const onClose = vi.fn();
  archive.mockResolvedValue({ project: { ...project, archivedAt: "today" } });
  render(<ProjectDrawer open project={project} computers={[]} onClose={onClose} onSaved={vi.fn()} />);
  confirm.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "project.archive" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(archive).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "project.archive" }));
  await waitFor(() => expect(archive).toHaveBeenCalledWith({ projectId: "p", expectedVersion: 1 }));
  expect(onClose).toHaveBeenCalled();
});

it("cancels settings and validates an empty name", async () => {
  const onClose = vi.fn();
  render(<ProjectDrawer open computers={[]} onClose={onClose} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  expect(screen.getByRole("alert").textContent).toBe("project.name_required");
  fireEvent.click(screen.getByRole("button", { name: "dialog.cancel" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it.each(["network", "conflict", "closed"])("keeps the draft if conflict recovery fails: %s", async (failure) => {
  const conflict = new RelayApiError("project_version_conflict", 409, "project_version_conflict");
  update.mockRejectedValueOnce(conflict);
  if (failure === "network") getProject.mockRejectedValue(new Error("Network unavailable"));
  else getProject.mockResolvedValue({ project: { ...project, version: 2, enabled: failure !== "closed" } });
  if (failure === "conflict") update.mockRejectedValueOnce(conflict);
  const onClose = vi.fn();
  render(<ProjectDrawer open project={project} computers={[]} onClose={onClose} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "project.save" }));
  await screen.findByRole("alert");
  expect(update).toHaveBeenCalledTimes(failure === "conflict" ? 2 : 1);
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Keep my draft");
});

it("reports an ordinary save error without fetching or retrying", async () => {
  update.mockRejectedValue(new RelayApiError("project_name_taken", 409, "project_name_taken"));
  render(<ProjectDrawer open project={project} computers={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "project.save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("project_name_taken");
  expect(getProject).not.toHaveBeenCalled();
});
