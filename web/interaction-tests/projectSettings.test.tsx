import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectDrawer } from "../src/components/ProjectDrawer";
import type { DaemonNodeMonitorRecord, ProjectRecord } from "../src/types";

const { update, create, archive, getProject, confirm } = vi.hoisted(() => ({ update: vi.fn(), create: vi.fn(), archive: vi.fn(), getProject: vi.fn(), confirm: vi.fn() }));
vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), getProject }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  updateProjectMutation: { isPending: false, mutateAsync: update },
  createProjectMutation: { isPending: false, mutateAsync: create },
  deleteProjectMutation: { isPending: false, mutateAsync: vi.fn() },
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

it("still requires a computer to create a project", () => {
  render(<ProjectDrawer open computers={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "project.name" }), { target: { value: "New project" } });
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("project.computer_required");
});

it("creates a project on the selected compatible computer", async () => {
  const onSaved = vi.fn();
  create.mockResolvedValue({ project });
  render(<ProjectDrawer open computers={computers} onClose={vi.fn()} onSaved={onSaved} />);
  fireEvent.change(screen.getByRole("textbox", { name: "project.name" }), { target: { value: "New project" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "node" } });
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "New project", daemonNodeId: "node", leadAgentId: null, members: [] }));
  expect(onSaved).toHaveBeenCalledWith(project);
});

it("creates a project with a description", async () => {
  create.mockResolvedValue({ project });
  render(<ProjectDrawer open computers={computers} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "project.name" }), { target: { value: "New project" } });
  fireEvent.change(screen.getByRole("textbox", { name: /^project\.description/ }), { target: { value: "What it is for" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "node" } });
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({
    name: "New project", description: "What it is for", daemonNodeId: "node", leadAgentId: null, members: [],
  }));
});

it("cancels settings and validates an empty name", async () => {
  const onClose = vi.fn();
  render(<ProjectDrawer open computers={[]} onClose={onClose} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "project.create" }));
  expect(screen.getByRole("alert").textContent).toBe("project.name_required");
  fireEvent.click(screen.getByRole("button", { name: "dialog.cancel" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});
