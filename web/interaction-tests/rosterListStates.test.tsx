import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { listDaemonNodes } from "../src/api";
import { AgentsPage } from "../src/components/AgentsPage";
import { ComputerPage } from "../src/components/ComputerPage";
import { NODES_QUERY_KEY, useRelayData } from "../src/hooks/useRelayData";
import { USER_AGENTS_QUERY_KEY } from "../src/hooks/useUserAgents";
import type { CurrentUser, DaemonNodeMonitorRecord, UserAgent } from "../src/types";

vi.mock("../src/api", async (original) => ({
  ...await original<typeof import("../src/api")>(),
  listDaemonNodes: vi.fn(),
  listSessionSummaries: vi.fn(async () => ({ sessions: [] })),
  listTasks: vi.fn(async () => ({ tasks: [] })),
}));
vi.mock("../src/components/ui/DialogProvider", () => ({ useDialogs: () => ({}) }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

const user: CurrentUser = { id: "member", userId: "member", username: "member", role: "user" };
const time = "2026-11-23T00:00:00.000Z";
const agent: UserAgent = {
  id: "ada", displayName: "Ada", executorKind: "codex", enabled: true, version: 1,
  availability: "offline", bindingStatus: "runtime_missing", placements: [],
  skillPolicy: {}, toolPolicy: {}, modelPolicy: {}, createdAt: time, updatedAt: time,
};
const pendingComputer: DaemonNodeMonitorRecord = {
  id: "portable", displayName: "Office laptop", userId: user.userId,
  status: "provisioning", nodeLocation: "user-device", online: false, stale: true,
  dispatchable: false, agents: { codex: "unknown" }, activeRuns: [], queuedCommandCount: 0,
  createdAt: time, updatedAt: time,
};

function Computers() {
  const { nodes, nodesStatus, refetchNodes } = useRelayData(undefined, true, false, true, false,
    undefined, undefined, { pageOwned: true, projectDirectory: false });
  return <ComputerPage nodes={nodes} nodesStatus={nodesStatus} onRetry={refetchNodes} currentUser={user} />;
}

const clients: QueryClient[] = [];
function createClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return client;
}

afterEach(() => {
  clients.splice(0).forEach(client => client.clear());
  vi.mocked(listDaemonNodes).mockReset();
});

it("shows only the most specific status on an unavailable Agent and keeps its row actionable", async () => {
  const client = createClient();
  const records = [
    agent,
    { ...agent, id: "gone", displayName: "Grace", bindingStatus: "computer_gone" },
    { ...agent, id: "offline", displayName: "Lin", bindingStatus: undefined },
  ] satisfies UserAgent[];
  client.setQueryData([USER_AGENTS_QUERY_KEY, user.userId], { agents: records });
  const open = vi.fn();
  render(<QueryClientProvider client={client}>
    <AgentsPage currentUser={user} detailAgent={null} onOpenAgent={open} onBackToAgents={vi.fn()} onOpenThread={vi.fn()} />
  </QueryClientProvider>);

  const ada = screen.getByRole("button", { name: /Ada/ });
  expect(within(ada).getByText("agents_page.binding_status_runtime_missing")).toBeTruthy();
  expect(within(ada).queryByText("status.offline")).toBeNull();
  const grace = screen.getByRole("button", { name: /Grace/ });
  expect(within(grace).getByText("agents_page.binding_status_computer_gone")).toBeTruthy();
  expect(within(grace).queryByText("status.offline")).toBeNull();
  expect(within(screen.getByRole("button", { name: /Lin/ })).getByText("status.offline")).toBeTruthy();
  fireEvent.click(ada);
  expect(open).toHaveBeenCalledWith(agent);

  act(() => client.setQueryData([USER_AGENTS_QUERY_KEY, user.userId], {
    agents: [{ ...agent, availability: "ready", bindingStatus: "available" }, ...records.slice(1)],
  }));
  await waitFor(() => expect(within(ada).queryByText("agents_page.binding_status_runtime_missing")).toBeNull());
});

it("keeps unavailable Agent status aligned between the roster row and Agent detail view", async () => {
  const client = createClient();
  client.setQueryData([USER_AGENTS_QUERY_KEY, user.userId], { agents: [agent] });
  const { container } = render(<QueryClientProvider client={client}>
    <AgentsPage currentUser={user} detailAgent={agent} onOpenAgent={vi.fn()} onBackToAgents={vi.fn()} onOpenThread={vi.fn()} />
  </QueryClientProvider>);

  const row = container.querySelector(".agents-roster-row");
  expect(row?.getAttribute("data-unavailable")).toBe("true");
  expect(screen.getAllByText("agents_page.binding_status_runtime_missing").length).toBeGreaterThanOrEqual(2);
});

it("distinguishes a Computer awaiting first connection from offline, reconnecting, and online", async () => {
  const client = createClient();
  const list = vi.mocked(listDaemonNodes);
  list.mockResolvedValue({ nodes: [pendingComputer] });
  render(<QueryClientProvider client={client}><Computers /></QueryClientProvider>);
  await screen.findByRole("link", { name: pendingComputer.displayName });
  expect(screen.getByText("computer.connect_waiting")).toBeTruthy();
  expect(screen.getByText("computer.connect_waiting_hint")).toBeTruthy();
  expect(screen.queryByText("nodes.presence_offline")).toBeNull();
  // Pending computers hide the empty runtimes block to keep the card concise.
  expect(screen.queryByText("admin.v2.node_runtimes")).toBeNull();

  const update = async (node: DaemonNodeMonitorRecord, label: string) => {
    list.mockResolvedValueOnce({ nodes: [node] });
    await act(async () => { await client.refetchQueries({ queryKey: NODES_QUERY_KEY, exact: true }); });
    await screen.findByText(label, { selector: ".adm-presence-pill-label" });
    expect(screen.queryByText("computer.connect_waiting")).toBeNull();
  };
  const registered = { ...pendingComputer, status: "ready", lastSeenAt: time } satisfies DaemonNodeMonitorRecord;
  await update(registered, "nodes.presence_offline");
  // The notice keeps the recovery guidance without repeating the connection heading.
  expect(screen.queryByText("computer.connection_offline_title")).toBeNull();
  expect(screen.getByText("computer.connection_offline_body")).toBeTruthy();
  await update({ ...registered, online: true, stale: false }, "nodes.presence_unsettled");
  await update({ ...registered, online: true, stale: false, dispatchable: true }, "nodes.presence_online");
});

it("highlights a revoked Computer in the header without duplicating its notice title", async () => {
  const client = createClient();
  const list = vi.mocked(listDaemonNodes);
  const revoked: DaemonNodeMonitorRecord = {
    ...pendingComputer,
    status: "stopped",
    lastSeenAt: time,
    transport: { state: "revoked", causes: ["revoked"] },
  };
  list.mockResolvedValue({ nodes: [revoked] });
  render(<QueryClientProvider client={client}><Computers /></QueryClientProvider>);
  await screen.findByRole("link", { name: revoked.displayName });
  expect(screen.getAllByText("computer.connection_revoked_title")).toHaveLength(1);
  expect(screen.getByText("computer.connection_revoked_body")).toBeTruthy();
});

it("shows loading, then a retryable failure, then the successful empty Computer list", async () => {
  const client = createClient();
  const list = vi.mocked(listDaemonNodes);
  let rejectRequest: (reason: Error) => void = () => {};
  list.mockImplementationOnce(() => new Promise((_, reject) => { rejectRequest = reject; }));
  render(<QueryClientProvider client={client}><Computers /></QueryClientProvider>);
  expect(screen.getByRole("status").textContent).toContain("admin.loading");
  expect(screen.queryByText("computer.empty_title")).toBeNull();

  act(() => rejectRequest(new Error("Unavailable")));
  await screen.findByRole("heading", { name: "computer.load_failed" });
  expect(screen.queryByText("computer.empty_title")).toBeNull();

  list.mockResolvedValueOnce({ nodes: [] });
  fireEvent.click(screen.getByRole("button", { name: "workspace.retry" }));
  await screen.findByRole("heading", { name: "computer.empty_title" });
  expect(screen.queryByText("computer.load_failed")).toBeNull();
  expect(list).toHaveBeenCalledTimes(2);
});

it("keeps Computer records visible after a background refresh fails", async () => {
  const client = createClient();
  const list = vi.mocked(listDaemonNodes);
  list.mockResolvedValueOnce({ nodes: [pendingComputer] });
  render(<QueryClientProvider client={client}><Computers /></QueryClientProvider>);
  await screen.findByRole("link", { name: pendingComputer.displayName });
  list.mockRejectedValueOnce(new Error("Unavailable"));
  await act(async () => { await client.refetchQueries({ queryKey: NODES_QUERY_KEY, exact: true }); });
  expect(screen.getByRole("link", { name: pendingComputer.displayName })).toBeTruthy();
  expect(screen.queryByText("computer.load_failed")).toBeNull();
  expect(screen.queryByText("computer.empty_title")).toBeNull();
});
