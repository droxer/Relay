import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { CreateAgentDialog } from "../src/components/agents/CreateAgentDialog";
import { agentLabel } from "../src/lib/plan";
import { AGENT_RUNTIME_DISPLAY_ORDER } from "../src/lib/agentRuntimeOrder";
import { AGENT_NAMES } from "../src/types";

const api = vi.hoisted(() => ({ listDaemonNodes: vi.fn(), createAgent: vi.fn() }));
vi.mock("../src/api", () => api);
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
// Only flatten floating layers; runtime selection and the model picker stay real.
vi.mock("@base-ui/react/autocomplete", async (importOriginal) => {
  const { Autocomplete } = await importOriginal<typeof import("@base-ui/react/autocomplete")>();
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return { Autocomplete: { ...Autocomplete, Portal: Box, Positioner: Box, Popup: Box } };
});
vi.mock("../src/components/ComputerSelect", () => ({
  ComputerSelect: ({ options, value, onChange, labelledBy }: {
    options: { computerId: string; label: string }[];
    value: string; onChange: (value: string) => void; labelledBy: string;
  }) => (
    <select aria-labelledby={labelledBy} value={value} onChange={event => onChange(event.target.value)}>
      <option value="" />
      {options.map(option => <option key={option.computerId} value={option.computerId}>{option.label}</option>)}
    </select>
  ),
}));

it("shows every reported model after selecting each runtime on a running computer", async () => {
  const catalogs = Object.fromEntries(AGENT_NAMES.map(kind => [kind, [`${kind}/fast`, `${kind}/deep`, `${kind}/large`]]));
  api.listDaemonNodes.mockResolvedValue({ nodes: [{
    id: "node-1", userId: "alice", workspaceId: "mac", displayName: "My computer",
    status: "running", online: true, stale: false, activeRuns: [], queuedCommandCount: 0,
    agents: Object.fromEntries(AGENT_NAMES.map(kind => [kind, "ready"])),
    capabilities: ["agent-model", "endpoint-models"],
    customModelEndpoints: ["codex", "claude"], agentModels: catalogs,
  }] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={client}>
      <CreateAgentDialog open userId="alice" onClose={vi.fn()} onCreated={vi.fn()} />
    </QueryClientProvider>,
  );
  try {
    await screen.findByRole("option", { name: "My computer" });
    fireEvent.change(screen.getByRole("combobox", { name: "agents_page.create_computer_label" }), {
      target: { value: "device:alice:mac" },
    });
    expect(screen.queryByRole("radio", { name: "Kimi" })).toBeNull();
    for (const kind of AGENT_RUNTIME_DISPLAY_ORDER) {
      await user.click(screen.getByRole("radio", { name: agentLabel(kind) }));
      const input = screen.getByRole("combobox", { name: "agents_page.model_label" }) as HTMLInputElement;
      expect(input.value).toBe("");
      await user.click(screen.getByRole("button", { name: "agents_page.model_browse" }));
      await waitFor(() => expect(screen.getAllByRole("option").filter(option => option.closest('[role="listbox"]')).map(option => option.textContent)).toEqual(catalogs[kind]));
      await user.click(screen.getByRole("option", { name: catalogs[kind][2] }));
      expect(input.value).toBe(catalogs[kind][2]);
    }
  } finally {
    view.unmount();
    client.clear();
  }
});
