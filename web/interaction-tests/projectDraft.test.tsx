import { fireEvent, render } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import { ProjectMemberEditor } from "../src/components/ProjectMemberEditor";
vi.mock("../src/hooks/useRelayMutations", () => ({ useRelayMutations: () => ({ updateProjectMutation: { isPending: false, mutateAsync: vi.fn() } }) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({ confirm: vi.fn() }) }));
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
