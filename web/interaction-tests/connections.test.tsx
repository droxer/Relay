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

function composer() {
  return <Composer connectionTargetId="thread" logicalAgents={[]} activeLogicalAgentId={null}
    onLogicalAgentPicked={vi.fn()} activeAgentDisplayName="Ada" selectedUser="u1" initializingThread={false}
    runtimeNodes={[]} runtimeNodeId="node" selectedRuntimeNode={null} activeRuntimeNode={null}
    onRuntimeNodeChange={vi.fn()} running={false} onSend={vi.fn(async () => true)} onCancelRun={vi.fn()} />;
}

it("keeps connections out of the composer until a service is connected", async () => {
  vi.mocked(connectionsApi.listConnections).mockClear().mockResolvedValueOnce({ connections: [] });
  render(composer(), { wrapper });
  await waitFor(() => expect(connectionsApi.listConnections).toHaveBeenCalled());
  await screen.findByRole("textbox");
  expect(screen.queryByText("connections.title")).toBeNull();
});

it("keeps a draft's grants visible after their connection is gone so they can be removed", async () => {
  vi.mocked(connectionsApi.listConnections).mockResolvedValueOnce({ connections: [] });
  render(<ConnectionGrantField value={[{ connectionId: "gone", resources: ["octo/hello"], actions: ["github.list_issues"] }]} onChange={vi.fn()} />, { wrapper });
  expect(await screen.findByText("connections.title")).toBeTruthy();
});

it("does not resave old access when the next ordinary message is sent", async () => {
  vi.mocked(connectionsApi.saveConnectionGrants).mockClear();
  const send = vi.fn(async () => true);
  render(<Composer connectionTargetId="thread" logicalAgents={[]} activeLogicalAgentId={null}
    onLogicalAgentPicked={vi.fn()} activeAgentDisplayName="Ada" selectedUser="u1" initializingThread={false}
    runtimeNodes={[]} runtimeNodeId="node" selectedRuntimeNode={null} activeRuntimeNode={null}
    onRuntimeNodeChange={vi.fn()} running={false} onSend={send} onCancelRun={vi.fn()} />, { wrapper });
  fireEvent.click(await screen.findByText("connections.title"));
  // The Thread's saved access keeps the picker read-only until it loads.
  await waitFor(() => expect(screen.queryByText("connections.loading")).toBeNull());
  fireEvent.click(await screen.findByRole("checkbox", { name: /Personal/ }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "octo/hello" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "First message" } });
  fireEvent.submit(document.querySelector("form.composer")!);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(connectionsApi.saveConnectionGrants).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Second message" } });
  fireEvent.submit(document.querySelector("form.composer")!);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(connectionsApi.saveConnectionGrants).toHaveBeenCalledTimes(1);
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
