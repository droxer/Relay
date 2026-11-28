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

it.each(AGENT_RUNTIME_DISPLAY_ORDER)("shows every reported model for the selected computer and %s runtime", async (kind) => {
  const catalogs = Object.fromEntries(AGENT_NAMES.map(kind => [
    kind,
    Array.from({ length: kind === "opencode" ? 225 : 3 }, (_, index) => `${kind}/model-${index}`),
  ]));
  const computer = {
    id: "node-1", userId: "alice", workspaceId: "mac", displayName: "My computer",
    status: "running", online: true, stale: false, activeRuns: [], queuedCommandCount: 0,
    agents: Object.fromEntries(AGENT_NAMES.map(kind => [kind, "ready"])),
    capabilities: ["agent-model", "endpoint-models"],
    customModelEndpoints: ["codex", "claude"], agentModels: catalogs,
  };
  const otherModel = "other/provider-model";
  api.listDaemonNodes.mockResolvedValue({ nodes: [computer, {
    ...computer,
    id: "node-2", workspaceId: "linux", displayName: "Other computer",
    agents: { opencode: "ready" }, agentModels: { opencode: [otherModel] },
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
    await user.click(screen.getByRole("radio", { name: agentLabel(kind) }));
    const input = screen.getByRole<HTMLInputElement>("combobox", { name: "agents_page.model_label" });
    expect(input.value).toBe("");
    await user.click(screen.getByRole("button", { name: "agents_page.model_browse" }));
    await waitFor(() => expect(screen.getAllByRole("option").filter(option => option.closest('[role="listbox"]')).map(option => option.textContent)).toEqual(catalogs[kind]));
    const lastModel = catalogs[kind].at(-1)!;
    await user.click(screen.getByRole("option", { name: lastModel }));
    expect(input.value).toBe(lastModel);
    const nextRuntime = kind === "codex" ? "claude" : "codex";
    await user.click(screen.getByRole("radio", { name: agentLabel(nextRuntime) }));
    const nextInput = screen.getByRole<HTMLInputElement>("combobox", { name: "agents_page.model_label" });
    expect(nextInput.value).toBe("");
    await user.click(screen.getByRole("button", { name: "agents_page.model_browse" }));
    await user.click(screen.getByRole("option", { name: catalogs[nextRuntime][0] }));
    expect(nextInput.value).toBe(catalogs[nextRuntime][0]);
    fireEvent.change(screen.getByRole("combobox", { name: "agents_page.create_computer_label" }), {
      target: { value: "device:alice:linux" },
    });
    expect(screen.getByRole<HTMLInputElement>("combobox", { name: "agents_page.model_label" }).value).toBe("");
    await user.click(screen.getByRole("button", { name: "agents_page.model_browse" }));
    expect(await screen.findByRole("option", { name: otherModel })).toBeTruthy();
  } finally {
    view.unmount();
    client.clear();
  }
});
