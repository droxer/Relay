import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useThreadQueue } from "../src/hooks/useThreadQueue";
import { apiJson } from "../src/api-client/client";

vi.mock("../src/api-client/client", () => ({ apiJson: vi.fn() }));
vi.mock("../src/api-client/sessions", () => ({ cancelRun: vi.fn(async () => ({})) }));
let saved: { messages: { id: string; text: string }[]; paused: boolean };
beforeEach(() => {
  saved = { messages: [], paused: false };
  sessionStorage.clear();
  vi.mocked(apiJson).mockImplementation(async (_path, options: any) => {
    if (options?.method === "POST") {
      const { action, id, text } = options.body;
      if ((action === "enqueue" || action === "import") && !saved.messages.some(m => m.id === id)) saved.messages.push({ id, text });
      if (action === "remove" || action === "edit") saved.messages = saved.messages.filter(m => m.id !== id);
      if (action === "pause") saved.paused = true;
    }
    return structuredClone(saved) as any;
  });
});
function open(queueKey = "owner:thread") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const composer = { getText: () => "draft", setText: vi.fn(), focus: vi.fn(), send: vi.fn(), clear: vi.fn() };
  const cancel = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useThreadQueue({ queueKey, threadId: "thread", running: true, awaitsPerson: false,
    composerRef: { current: composer }, onCancelRun: cancel }), { wrapper });
  return { ...hook, client, composer, cancel };
}
it("independent clients read the persisted queue without dispatching from the browser", async () => {
  const laptop = open();
  await act(async () => { expect(await laptop.result.current.enqueue("Next step")).toBe(true); });
  laptop.unmount();
  const phone = open();
  await waitFor(() => expect(phone.result.current.messages.map(m => m.text)).toEqual(["Next step"]));
  expect(phone.composer.send).not.toHaveBeenCalled();
});
it("failed saving returns false and exposes a recoverable error", async () => {
  const hook = open();
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
  vi.mocked(apiJson).mockRejectedValueOnce(new Error("Offline"));
  await act(async () => { expect(await hook.result.current.enqueue("Keep this draft")).toBe(false); });
  expect(hook.result.current.error).toBe("Offline");
});
it("pauses durably before requesting Stop", async () => {
  const hook = open();
  await act(async () => { await hook.result.current.stop(); });
  expect(saved.paused).toBe(true);
  const { cancelRun } = await import("../src/api-client/sessions");
  expect(cancelRun).toHaveBeenCalledWith("thread");
});
it("only removes an edited message after acknowledgment and preserves the draft", async () => {
  saved.messages.push({ id: "q1", text: "queued" });
  const hook = open();
  await waitFor(() => expect(hook.result.current.messages).toHaveLength(1));
  await act(async () => { await hook.result.current.edit("q1"); });
  expect(hook.composer.setText).toHaveBeenCalledWith("draft\n\nqueued");
  expect(saved.messages).toEqual([]);
});
it("migrates legacy messages and clears local storage only after acknowledgment", async () => {
  sessionStorage.setItem("relay-web.queue:owner:thread", JSON.stringify([{ id: "legacy", text: "Old draft" }]));
  open();
  await waitFor(() => expect(saved.messages).toEqual([{ id: "legacy", text: "Old draft" }]));
  await waitFor(() => expect(sessionStorage.getItem("relay-web.queue:owner:thread")).toBeNull());
});
