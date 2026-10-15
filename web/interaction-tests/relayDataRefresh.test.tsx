import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRelayData } from "../src/hooks/useRelayData";
import { listDaemonNodes, listSandboxes } from "../src/api";
import { setSessionStreamConnected } from "../src/lib/sessionStreamStatus";
import { RELAY_POLL_INTERVALS_MS } from "../src/lib/relayPolling";

vi.mock("../src/api", () => ({
  listSandboxes: vi.fn(),
  listDaemonNodes: vi.fn(async () => ({ nodes: [] })),
  listSessionSummaries: vi.fn(async () => ({ sessions: [] })),
  listTasks: vi.fn(async () => ({ tasks: [] })),
  listProjects: vi.fn(async () => ({ projects: [] })),
}));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useRelayData("user-token", true), { wrapper });
  return { client, view };
}

beforeEach(() => { setSessionStreamConnected(false); });
afterEach(() => { setSessionStreamConnected(false); });

it("keeps a refresh's token override while an overlapping plain refresh settles", async () => {
  const tokens: string[] = [];
  let failNextMinted = true;
  let releasePlainNodes: (() => void) | undefined;
  let hangNextNodes = false;
  vi.mocked(listSandboxes).mockImplementation(async (token?: string) => {
    tokens.push(token ?? "");
    if (token === "minted" && failNextMinted) {
      failNextMinted = false;
      throw new Error("transient");
    }
    return { sandboxes: [] };
  });
  vi.mocked(listDaemonNodes).mockImplementation(() => {
    if (!hangNextNodes) return Promise.resolve({ nodes: [] });
    hangNextNodes = false;
    return new Promise((resolve) => { releasePlainNodes = () => resolve({ nodes: [] }); });
  });
  const { client, view } = setup();
  await waitFor(() => expect(tokens).toEqual(["user-token"]));
  await waitFor(() => expect(client.isFetching()).toBe(0));

  // A plain refresh whose sandboxes fetch lands while its nodes fetch hangs.
  hangNextNodes = true;
  let plain!: Promise<void>;
  act(() => { plain = view.result.current.refresh(); });
  await waitFor(() => expect(tokens).toEqual(["user-token", "user-token"]));
  await waitFor(() => expect(client.isFetching({ queryKey: ["relay", "sandboxes"] })).toBe(0));

  // The override refresh refetches sandboxes under the minted token (the first
  // attempt fails and retries) and takes over the hanging nodes fetch, so the
  // plain refresh settles while the override's sandboxes retry is pending.
  let minted!: Promise<void>;
  act(() => { minted = view.result.current.refresh(undefined, "minted"); });
  releasePlainNodes?.();
  await act(async () => { await Promise.all([plain, minted]); });

  expect(tokens.slice(2)).toEqual(["minted", "minted"]);
  expect(view.result.current.isRefreshing).toBe(false);
  view.unmount(); client.clear();
});

it("backs the sessions poll off while the session stream is connected", async () => {
  vi.mocked(listSandboxes).mockResolvedValue({ sandboxes: [] } as never);
  const { client, view } = setup();
  const sessionsQuery = () => client.getQueryCache().find({ queryKey: ["relay", "sessions"], exact: true });
  const interval = () => (sessionsQuery()?.observers[0]?.options.refetchInterval);
  await waitFor(() => expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.sessions));
  act(() => setSessionStreamConnected(true));
  await waitFor(() => expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.sessionsWhileStreaming));
  act(() => setSessionStreamConnected(false));
  await waitFor(() => expect(interval()).toBe(RELAY_POLL_INTERVALS_MS.sessions));
  const projects = client.getQueryCache().find({ queryKey: ["relay", "projects"], exact: true });
  expect(projects?.observers[0]?.options.refetchInterval).toBe(RELAY_POLL_INTERVALS_MS.projects);
  view.unmount(); client.clear();
});
