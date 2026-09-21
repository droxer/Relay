import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectDrawer } from "../src/components/ProjectDrawer";
import type { DaemonNodeMonitorRecord, ProjectRecord } from "../src/types";

const { update, create, archive } = vi.hoisted(() => ({ update: vi.fn(), create: vi.fn(), archive: vi.fn() }));
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({
  updateProjectMutation: { isPending: false, mutateAsync: update },
  createProjectMutation: { isPending: false, mutateAsync: create },
  archiveProjectMutation: { isPending: false, mutateAsync: archive },
}) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: async () => true }) }));
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children, open }: any) => open ? children : null }));
const project = { id: "p", version: 1, name: "Original", computerId: "node:node", members: [], leadAgentId: null, enabled: true } as ProjectRecord;
const computers = [{ id: "node", capabilities: ["project-workspaces"] }] as DaemonNodeMonitorRecord[];
beforeEach(() => { update.mockReset().mockResolvedValue({ project }); create.mockReset(); archive.mockReset(); });

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
