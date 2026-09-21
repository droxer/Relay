import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, it, expect, vi } from "vitest";
import { ProjectMemberEditor } from "../src/components/ProjectMemberEditor";
import { RelayApiError } from "../src/api";
const { mutateAsync, confirm, getProject } = vi.hoisted(() => ({ mutateAsync: vi.fn(), confirm: vi.fn(), getProject: vi.fn() }));
vi.mock("../src/api", async (original) => ({ ...await original<typeof import("../src/api")>(), getProject }));
beforeEach(() => { mutateAsync.mockReset().mockResolvedValue({}); confirm.mockReset().mockResolvedValue(true); getProject.mockReset(); });
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
  const member = { agentId: "a", role: "implementer", functionTitle: "Original", responsibilities: "Build", enabled: true };
  const project = { id: "p", version: 1, name: "Project", members: [member], leadAgentId: null, computerId: "c" } as any;
  const props = { open: true, member: member as any, project, agents: [], computers: [], onClose: vi.fn() };
  const view = render(<ProjectMemberEditor {...props} />);
  const input = view.container.querySelector('input[name="function-title"]') as HTMLInputElement;
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

it("recovers a stale save while retaining other members and unedited fields", async () => {
  const base = { id: "p", version: 1, name: "Project", computerId: "c", members: [lead], leadAgentId: "a", enabled: true } as any;
  getProject.mockResolvedValue({ project: { ...base, version: 2, members: [{ ...lead, responsibilities: "New responsibility" }, other] } });
  mutateAsync.mockRejectedValueOnce(new RelayApiError("project_version_conflict", 409, "project_version_conflict"));
  render(<ProjectMemberEditor open member={lead as any} project={base} agents={[]} computers={[]} onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "project.function_title" }), { target: { value: "My draft" } });
  fireEvent.click(screen.getByRole("button", { name: "project.member_save" }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
  const patch = mutateAsync.mock.calls[1][0].input;
  expect(patch.expectedVersion).toBe(2);
  expect(patch.members).toEqual([{ ...lead, functionTitle: "My draft", responsibilities: "New responsibility" }, other]);
  expect(confirm).toHaveBeenCalled();
});

it("preserves the draft if the user declines replacing a concurrent edit", async () => {
  const base = { id: "p", version: 1, name: "Project", computerId: "c", members: [lead], leadAgentId: "a", enabled: true } as any;
  getProject.mockResolvedValue({ project: { ...base, version: 2, members: [{ ...lead, functionTitle: "Their title" }] } });
  mutateAsync.mockRejectedValueOnce(new RelayApiError("project_version_conflict", 409, "project_version_conflict"));
  confirm.mockResolvedValue(false);
  const onClose = vi.fn();
  render(<ProjectMemberEditor open member={lead as any} project={base} agents={[]} computers={[]} onClose={onClose} />);
  fireEvent.change(screen.getByRole("textbox", { name: "project.function_title" }), { target: { value: "My title" } });
  fireEvent.click(screen.getByRole("button", { name: "project.member_save" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(confirm.mock.calls[0][0].message).toContain("Their title");
  expect(confirm.mock.calls[0][0].message).toContain("My title");
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox", { name: "project.function_title" }) as HTMLInputElement).value).toBe("My title");
});

it("does not resurrect a member removed during editing", async () => {
  getProject.mockResolvedValue({ project: { id: "p", version: 2, enabled: true, members: [], leadAgentId: null } });
  mutateAsync.mockRejectedValueOnce(new RelayApiError("project_version_conflict", 409, "project_version_conflict"));
  const { onClose } = editor();
  fireEvent.change(screen.getByRole("textbox", { name: "project.function_title" }), { target: { value: "My draft" } });
  fireEvent.click(screen.getByRole("button", { name: "project.member_save" }));
  await screen.findByRole("alert");
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

it("rebases removal without dropping a concurrently added member", async () => {
  getProject.mockResolvedValue({ project: { id: "p", version: 2, enabled: true, members: [lead, other, { ...other, agentId: "c" }], leadAgentId: "a" } });
  mutateAsync.mockRejectedValueOnce(new RelayApiError("project_version_conflict", 409, "project_version_conflict"));
  editor([lead, other], other);
  fireEvent.click(screen.getByRole("button", { name: "project.member_remove" }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
  expect(mutateAsync.mock.calls[1][0].input.members.map((m: any) => m.agentId)).toEqual(["a", "c"]);
});
