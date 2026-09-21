import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, it, expect, vi } from "vitest";
import { ProjectMemberEditor } from "../src/components/ProjectMemberEditor";
const { mutateAsync, confirm } = vi.hoisted(() => ({ mutateAsync: vi.fn(), confirm: vi.fn() }));
beforeEach(() => { mutateAsync.mockReset().mockResolvedValue({}); confirm.mockReset().mockResolvedValue(true); });
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({ updateProjectMutation: { isPending: false, mutateAsync } }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm }) }));
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange }: any) => <select aria-label="project.member_agent" value={value} onChange={(event) => onValueChange(event.target.value)}><option value="">Choose</option><option value="a">Alice</option></select>,
  SelectContent: () => null, SelectGroup: () => null, SelectItem: () => null,
  SelectTrigger: () => null, SelectValue: () => null,
}));
vi.mock("@/components/ui/Drawer", () => ({ Drawer: ({ children }: any) => children }));
it("preserves a dirty member draft when polling advances the project version", () => {
  const member = { agentId: "a", role: "implementer", responsibilities: "Build", enabled: true };
  const project = { id: "p", version: 1, name: "Project", members: [member], leadAgentId: null, computerId: "c" } as any;
  const props = { open: true, member: member as any, project, agents: [], computers: [], onClose: vi.fn() };
  const view = render(<ProjectMemberEditor {...props} />);
  const input = view.container.querySelector('textarea[name="responsibilities"]') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Unsaved work" } });
  view.rerender(<ProjectMemberEditor {...props} project={{ ...project, version: 2 }} />);
  expect(input.value).toBe("Unsaved work");
});

const lead = { agentId: "a", role: "implementer", functionTitle: "Lead", responsibilities: "Build", enabled: true };
const other = { ...lead, agentId: "b" };
function editor(members = [lead], member: typeof lead | null = lead, leadAgentId: string | null = "a") {
  const onClose = vi.fn();
  const view = render(<ProjectMemberEditor open member={member as any}
    project={{ id: "p", version: 1, name: "Project", computerId: "c", members, leadAgentId } as any}
    agents={[{ id: "a", displayName: "Alice", executorKind: "codex", enabled: true, placements: [{ computerId: "c", desiredState: "active" }] }] as any}
    computers={[]} onClose={onClose} />);
  return { ...view, onClose };
}

it("assigns the first added agent as lead by default", async () => {
  editor([], null, null);
  fireEvent.change(screen.getByRole("combobox", { name: "project.member_agent" }), { target: { value: "a" } });
  fireEvent.change(screen.getByRole("textbox", { name: "project.responsibilities" }), { target: { value: "Build" } });
  fireEvent.click(screen.getByRole("button", { name: "project.member_save" }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
  expect(mutateAsync.mock.calls[0][0].input.leadAgentId, "null lead causes project_lead_not_member").toBe("a");
});

it.each(["project.member_make_lead", "project.member_enabled"])("validates %s before submitting a roster without an enabled lead", async (name) => {
  const { onClose } = editor();
  fireEvent.click(screen.getByRole("checkbox", { name }));
  fireEvent.click(screen.getByRole("button", { name: "project.member_save" }));
  expect(mutateAsync).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("project.member_lead_required");
  expect(onClose).not.toHaveBeenCalled();
});

it("removing the lead chooses an enabled successor", async () => {
  editor([lead, { ...other, enabled: false }, { ...other, agentId: "c" }]);
  fireEvent.click(screen.getByRole("button", { name: "project.member_remove" }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
  expect(mutateAsync.mock.calls[0][0].input.leadAgentId).toBe("c");
});

it("blocks removing the only enabled lead while disabled members remain", async () => {
  editor([lead, { ...other, enabled: false }]);
  fireEvent.click(screen.getByRole("button", { name: "project.member_remove" }));
  await screen.findByRole("alert");
  expect(mutateAsync).not.toHaveBeenCalled();
});

it("allows removing the final member and clearing the lead", async () => {
  editor();
  fireEvent.click(screen.getByRole("button", { name: "project.member_remove" }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ projectId: "p", input: { expectedVersion: 1, leadAgentId: null, members: [] } }));
});

it("keeps the existing lead when adding another member", async () => {
  editor([other], null, "b");
  fireEvent.change(screen.getByRole("combobox", { name: "project.member_agent" }), { target: { value: "a" } });
  fireEvent.change(screen.getByRole("textbox", { name: "project.responsibilities" }), { target: { value: "Build" } });
  fireEvent.click(screen.getByRole("button", { name: "project.member_save" }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
  expect(mutateAsync.mock.calls[0][0].input.leadAgentId).toBe("b");
});

it("allows assigning another enabled member as lead", async () => {
  editor([lead, other], other);
  fireEvent.click(screen.getByRole("checkbox", { name: "project.member_make_lead" }));
  fireEvent.click(screen.getByRole("button", { name: "project.member_save" }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
  expect(mutateAsync.mock.calls[0][0].input.leadAgentId).toBe("b");
});
