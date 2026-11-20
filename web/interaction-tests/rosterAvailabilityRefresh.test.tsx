import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useRosterAvailabilityRefresh } from "../src/hooks/useRosterAvailabilityRefresh";
import { TEAMS_QUERY_KEY } from "../src/hooks/useTeams";
import { USER_AGENTS_QUERY_KEY } from "../src/hooks/useUserAgents";
import type { NodeAvailabilityInput } from "../src/lib/relayPolling";

const ready: NodeAvailabilityInput = { id: "n1", status: "ready", online: true, dispatchable: true, agents: { claude: "ready" } };

function setup(initial: { nodes: NodeAvailabilityInput[]; ready: boolean }) {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ nodes, ready: isReady }) => useRosterAvailabilityRefresh(nodes, isReady), { wrapper, initialProps: initial });
  return { invalidate, view };
}

it("records the first reading without refetching the roster", () => {
  const { invalidate } = setup({ nodes: [ready], ready: true });
  expect(invalidate).not.toHaveBeenCalled();
});

it("does not refetch the roster when a poll returns the same availability", () => {
  const { invalidate, view } = setup({ nodes: [ready], ready: true });
  view.rerender({ nodes: [{ ...ready, agents: { claude: "ready" } }], ready: true });
  expect(invalidate).not.toHaveBeenCalled();
});

it("refetches agents and teams when a computer goes offline", () => {
  const { invalidate, view } = setup({ nodes: [ready], ready: true });
  view.rerender({ nodes: [{ ...ready, online: false }], ready: true });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: [USER_AGENTS_QUERY_KEY] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: [TEAMS_QUERY_KEY] });
});

it("takes its baseline from the first loaded nodes, not the empty placeholder", () => {
  const { invalidate, view } = setup({ nodes: [], ready: false });
  view.rerender({ nodes: [ready], ready: true });
  expect(invalidate).not.toHaveBeenCalled();
});
