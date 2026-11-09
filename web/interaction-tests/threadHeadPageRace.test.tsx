import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { listSessionSummaries } from "../src/api";
import { useRelayData, SESSIONS_QUERY_KEY } from "../src/hooks/useRelayData";
import type { RelaySession } from "../src/types";

vi.mock("../src/api", () => ({
  listSessionSummaries: vi.fn(), listDaemonNodes: async () => ({ nodes: [] }),
  listSandboxes: async () => ({ sandboxes: [] }), listTasks: async () => ({ tasks: [] }),
  listProjects: async () => ({ projects: [] }),
}));

it.each([null, "older-cursor"])("keeps updates made during a head request (nextCursor=%s)", async nextCursor => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const a = { id: "A", updatedAt: "2026-11-09T12:00:00Z", events: [], agentRuns: [], artifacts: [], decisions: [] } as unknown as RelaySession;
  client.setQueryData(SESSIONS_QUERY_KEY, [a]);
  let finish!: (page: Awaited<ReturnType<typeof listSessionSummaries>>) => void;
  vi.mocked(listSessionSummaries).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const hook = renderHook(() => useRelayData(undefined, true), { wrapper });
  await waitFor(() => expect(client.isFetching({ queryKey: SESSIONS_QUERY_KEY })).toBe(1));
  const updated = { ...a, updatedAt: "2026-11-09T12:00:02Z", events: [{ id: "new-event" }] } as RelaySession;
  act(() => client.setQueryData(SESSIONS_QUERY_KEY, [updated]));
  await act(async () => { finish({ sessions: [{ id: "B", updatedAt: "2026-11-09T12:00:01Z", eventCount: 0 }], nextCursor } as Awaited<ReturnType<typeof listSessionSummaries>>); });
  await waitFor(() => expect(client.isFetching({ queryKey: SESSIONS_QUERY_KEY })).toBe(0));
  expect(client.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY)?.find(s => s.id === "A")).toEqual(updated);
  // Preservation lasts for the racing request, not forever: a later complete
  // response can still remove a deleted thread that has not changed again.
  vi.mocked(listSessionSummaries).mockResolvedValue({ sessions: [], nextCursor: null });
  await act(async () => { await client.refetchQueries({ queryKey: SESSIONS_QUERY_KEY }); });
  expect(client.getQueryData(SESSIONS_QUERY_KEY)).toEqual([]);
  hook.unmount(); client.clear();
});
