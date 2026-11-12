import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { ConnectionsSection } from "../src/components/settings/ConnectionsSection";
import { ConnectionGrantField } from "../src/components/connections/ConnectionGrantField";
import { Composer } from "../src/components/composer/Composer";
import * as connectionsApi from "../src/api-client/connections";

vi.mock("../src/api-client/connections", async importOriginal => ({
  ...await importOriginal<typeof import("../src/api-client/connections")>(),
  listConnections: vi.fn(async () => ({ connections: [{ id: "github-1", provider: "github", identity: "octocat", label: "Personal", status: "connected", actions: ["github.list_issues"] }] })),
  listConnectionProviders: vi.fn(async () => ({ providers: [{ id: "github", name: "GitHub", configured: true, actions: ["github.list_issues"] }] })),
  connectionResources: vi.fn(async () => ({ resources: [{ id: "octo/hello", name: "octo/hello" }], nextCursor: null })),
  connectionUsage: vi.fn(async () => ({ usage: [] })),
  getConnectionGrants: vi.fn(async () => ({ grants: [], readOnly: false })),
  disconnectConnection: vi.fn(async () => ({ disconnected: true })),
  startConnection: vi.fn(async () => ({ url: "https://github.com/authorize" })),
  saveConnectionGrants: vi.fn(async () => ({})),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

it("shows the real connected GitHub identity and no other providers", async () => {
  render(<ConnectionsSection />, { wrapper });
  expect(await screen.findByText("octocat")).toBeTruthy();
  expect(screen.queryByText("Slack")).toBeNull();
  expect(screen.queryByText("Gmail")).toBeNull();
  expect(screen.getByRole("button", { name: "connections.disconnect" })).toBeTruthy();
});

it("selects explicit resources and read actions for a work draft", async () => {
  const onChange = vi.fn();
  const view = render(<ConnectionGrantField value={[]} onChange={onChange} />, { wrapper });
  fireEvent.click(await screen.findByText("connections.title"));
  fireEvent.click(await screen.findByRole("checkbox", { name: /Personal/ }));
  expect(onChange).toHaveBeenCalledWith([{ connectionId: "github-1", resources: [], actions: ["github.list_issues"] }]);
  view.rerender(<ConnectionGrantField value={[{ connectionId: "github-1", resources: [], actions: ["github.list_issues"] }]} onChange={onChange} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "octo/hello" }));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([{ connectionId: "github-1", resources: ["octo/hello"], actions: ["github.list_issues"] }]));
});

function composer(onSend = vi.fn(async () => true)) {
  return <Composer logicalAgents={[]} activeLogicalAgentId={null}
    onLogicalAgentPicked={vi.fn()} activeAgentDisplayName="Ada" selectedUser="u1" initializingThread={false}
    runtimeNodes={[]} runtimeNodeId="node" selectedRuntimeNode={null} activeRuntimeNode={null}
    onRuntimeNodeChange={vi.fn()} running={false} onSend={onSend} onCancelRun={vi.fn()} />;
}

it("keeps Connections out of the composer even when GitHub is connected", async () => {
  vi.mocked(connectionsApi.listConnections).mockClear();
  vi.mocked(connectionsApi.getConnectionGrants).mockClear();
  render(composer(), { wrapper });
  await screen.findByRole("textbox");
  expect(screen.queryByText("connections.title")).toBeNull();
  expect(connectionsApi.listConnections).not.toHaveBeenCalled();
  expect(connectionsApi.getConnectionGrants).not.toHaveBeenCalled();
});

it("keeps a draft's grants visible after their connection is gone so they can be removed", async () => {
  vi.mocked(connectionsApi.listConnections).mockResolvedValueOnce({ connections: [] });
  render(<ConnectionGrantField value={[{ connectionId: "gone", resources: ["octo/hello"], actions: ["github.list_issues"] }]} onChange={vi.fn()} />, { wrapper });
  expect(await screen.findByText("connections.title")).toBeTruthy();
});

it("sends ordinary messages without reading or changing Connection Grants", async () => {
  vi.mocked(connectionsApi.saveConnectionGrants).mockClear();
  const send = vi.fn(async () => true);
  render(composer(send), { wrapper });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "First message" } });
  fireEvent.submit(document.querySelector("form.composer")!);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenLastCalledWith(undefined, undefined, {});
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Second message" } });
  fireEvent.submit(document.querySelector("form.composer")!);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(connectionsApi.saveConnectionGrants).not.toHaveBeenCalled();
});

it("keeps inherited Automation access read-only in the picker", async () => {
  vi.mocked(connectionsApi.getConnectionGrants).mockResolvedValueOnce({ targetType: "task", targetId: "occurrence", readOnly: true,
    grants: [{ id: "grant", revision: 1, connectionId: "github-1", resources: ["octo/hello"], actions: ["github.list_issues"] }] });
  const onChange = vi.fn();
  render(<ConnectionGrantField targetType="task" targetId="occurrence" onChange={onChange} />, { wrapper });
  fireEvent.click(await screen.findByText("connections.title"));
  const resource = await screen.findByRole("checkbox", { name: "octo/hello" });
  fireEvent.click(resource);
  expect(onChange).not.toHaveBeenCalled();
});
