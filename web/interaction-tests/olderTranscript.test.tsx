import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useOlderTranscript } from "../src/hooks/useOlderTranscript";
import { readOlderTranscript } from "../src/api-client/sessions";
import { SESSIONS_QUERY_KEY } from "../src/lib/sessionPollMerge";
import type { RelaySession } from "../src/types";

vi.mock("../src/api-client/sessions", () => ({ readOlderTranscript: vi.fn() }));

it("keeps each Thread's earlier page pending when navigating back during another load", async () => {
  type Page = Awaited<ReturnType<typeof readOlderTranscript>>;
  const first = Promise.withResolvers<Page>();
  const second = Promise.withResolvers<Page>();
  vi.mocked(readOlderTranscript).mockImplementation((id) => id === "a" ? first.promise : second.promise);
  const client = new QueryClient();
  client.setQueryData(SESSIONS_QUERY_KEY, ["a", "b"].map(id => ({ id, eventStart: 1, events: [] })));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(({ id }) => useOlderTranscript(id), { initialProps: { id: "a" }, wrapper });
  const anchorA = vi.fn();
  const anchorB = vi.fn();
  let loadA!: Promise<void>;
  let loadB!: Promise<void>;
  act(() => { loadA = hook.result.current.load(anchorA); });
  hook.rerender({ id: "b" });
  expect(hook.result.current.pending).toBe(false);
  act(() => { loadB = hook.result.current.load(anchorB); });
  hook.rerender({ id: "a" });
  expect(hook.result.current.pending).toBe(true);
  const duplicate = vi.fn();
  act(() => { void hook.result.current.load(duplicate); });

  await act(async () => {
    second.resolve({ eventStart: 0, events: [] } as Page);
    await loadB;
  });
  expect(hook.result.current.pending).toBe(true);
  expect(anchorB).not.toHaveBeenCalled();
  await act(async () => {
    first.resolve({ eventStart: 0, events: [] } as Page);
    await loadA;
  });
  expect(hook.result.current.pending).toBe(false);
  expect(anchorA).toHaveBeenCalledOnce();
  expect(duplicate).not.toHaveBeenCalled();
  expect(readOlderTranscript).toHaveBeenCalledTimes(2);
  expect(client.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY)?.[0].eventStart).toBe(0);
});
