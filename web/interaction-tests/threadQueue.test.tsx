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
function open(
  queueKey = "owner:thread",
  running = true,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const composer = { getText: () => "draft", setText: vi.fn(), focus: vi.fn(), send: vi.fn(), clear: vi.fn() };
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useThreadQueue({ queueKey, threadId: "thread", running, awaitsPerson: false,
    composerRef: { current: composer } }), { wrapper });
  return { ...hook, client, composer };
}
it("independent clients read the persisted queue without dispatching from the browser", async () => {
  const laptop = open();
  await act(async () => { expect(await laptop.result.current.enqueue("Next step")).toBe(true); });
  laptop.unmount();
  const phone = open();
  await waitFor(() => expect(phone.result.current.messages.map(m => m.text)).toEqual(["Next step"]));
  expect(phone.composer.send).not.toHaveBeenCalled();
});

it("renders the acknowledged queue without a second GET after enqueue", async () => {
  const hook = open();
  await waitFor(() => expect(hook.client.isFetching()).toBe(0));
  const reads = () => vi.mocked(apiJson).mock.calls.filter(([, options]) => !options?.method).length;
  const before = reads();
  await act(async () => { expect(await hook.result.current.enqueue("Next step")).toBe(true); });
  await waitFor(() => expect(hook.result.current.messages.map(m => m.text)).toEqual(["Next step"]));
  expect(reads()).toBe(before);
});

it("backs off an empty queue during a run and picks up work queued elsewhere", async () => {
  vi.useFakeTimers();
  vi.mocked(apiJson).mockClear();
  const hook = open();
  await act(async () => {});
  expect(apiJson).toHaveBeenCalledTimes(1);

  saved.messages.push({ id: "remote", text: "From another tab" });
  await act(() => vi.advanceTimersByTimeAsync(4_000));
  expect(apiJson).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1_010));
  expect(hook.result.current.messages.map(message => message.id)).toEqual(["remote"]);

  saved.messages = [];
  await act(() => vi.advanceTimersByTimeAsync(1_010));
  expect(hook.result.current.messages).toEqual([]);
  hook.unmount(); hook.client.clear();
});
it("failed saving returns false and exposes a recoverable error", async () => {
  const hook = open();
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
  vi.mocked(apiJson).mockRejectedValueOnce(new Error("Offline"));
  await act(async () => { expect(await hook.result.current.enqueue("Keep this draft")).toBe(false); });
  expect(hook.result.current.error).toBe("queue.errors.change_failed");
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

it("persists the selected Agents and treats a changed target as a new retry intent", async () => {
  const hook = open();
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
  const posts: any[] = [];
  vi.mocked(apiJson).mockImplementation(async (_path, options: any) => {
    if (options?.method === "POST") {
      posts.push(options.body);
      throw new Error("Offline");
    }
    return saved as any;
  });
  await act(async () => { await hook.result.current.enqueue("Continue", { addressAgentIds: ["selected"] }); });
  await act(async () => { await hook.result.current.enqueue("Continue", { addressAgentIds: ["selected"] }); });
  await act(async () => { await hook.result.current.enqueue("Continue", { addressTeamId: "crew" }); });
  expect(posts[0]).toMatchObject({ text: "Continue", addressAgentIds: ["selected"] });
  expect(posts[0].id).toBe(posts[1].id);
  expect(posts[2]).toMatchObject({ text: "Continue", addressTeamId: "crew" });
  expect(posts[2].id).not.toBe(posts[1].id);
});

it.each([
  [{ code: "queue_full" }, "queue.errors.full"],
  [{ code: "queue_sending" }, "queue.errors.sending"],
  [{ code: "queue_changed" }, "queue.errors.changed"],
  [{ code: "queue_thread_closed" }, "queue.errors.closed"],
  [{ status: 401 }, "queue.errors.sign_in"],
  [{ status: 403 }, "queue.errors.forbidden"],
  [{ status: 404 }, "queue.errors.closed"],
])("localizes queue failure %j without exposing transport text", async (cause, key) => {
  const hook = open();
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
  vi.mocked(apiJson).mockRejectedValueOnce(cause);
  await act(async () => { await hook.result.current.enqueue("Keep draft"); });
  expect(hook.result.current.error).toBe(key);
});

it("requests Stop & send next in one action and localizes failures", async () => {
  const hook = open();
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
  const { cancelRun } = await import("../src/api-client/sessions");
  await act(async () => { await hook.result.current.steer("q1"); });
  expect(apiJson).toHaveBeenCalledWith("/threads/thread/queue", expect.objectContaining({
    body: expect.objectContaining({ action: "steer", id: "q1" }),
  }));
  expect(cancelRun).not.toHaveBeenCalled();
  vi.mocked(apiJson).mockRejectedValueOnce(new Error("Private server error"));
  await act(async () => { await hook.result.current.steer("q1"); });
  expect(hook.result.current.error).toBe("queue.errors.change_failed");
});

it("promotes a message without requesting Stop when the thread is idle", async () => {
  const hook = open("owner:thread", false);
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
  await act(async () => { await hook.result.current.steer("q1"); });
  expect(apiJson).toHaveBeenCalledWith("/threads/thread/queue", expect.objectContaining({
    body: expect.objectContaining({ action: "promote", id: "q1" }),
  }));
});

it("offers persisted undo and resumes through the same server queue", async () => {
  const removedAt = new Date().toISOString();
  vi.mocked(apiJson).mockResolvedValue({ messages: [], paused: true, removed: { message: { id: "old", text: "Saved" }, beforeId: null, removedAt } });
  const hook = open();
  await waitFor(() => expect(hook.result.current.removedAt).toBe(removedAt));
  await act(async () => { hook.result.current.undoRemove(); });
  expect(apiJson).toHaveBeenCalledWith("/threads/thread/queue", expect.objectContaining({ body: expect.objectContaining({ action: "undo_remove", id: "old" }) }));
  await act(async () => { hook.result.current.resume(); });
  expect(apiJson).toHaveBeenCalledWith("/threads/thread/queue", expect.objectContaining({ body: expect.objectContaining({ action: "resume" }) }));
});

it("localizes failed loading without exposing server details", async () => {
  vi.mocked(apiJson).mockRejectedValue(new Error("Private error"));
  const hook = open();
  await waitFor(() => expect(hook.result.current.error).toBe("queue.errors.unavailable"));
});

it("publishes the acknowledged queue while a poll with older state is still outstanding", async () => {
  const hook = open();
  const queryKey = ["thread-queue", "thread"];
  await waitFor(() => expect(hook.client.isFetching()).toBe(0));

  let stalePollSignal: AbortSignal | undefined;
  const readers: (() => void)[] = [];
  vi.mocked(apiJson).mockImplementation(async (_path, options) => {
    if (options?.method === "POST") {
      return { messages: [{ id: "canonical", text: "Next step" }], paused: false } as never;
    }
    stalePollSignal ??= options?.signal;
    return new Promise(resolve => { readers.push(() => resolve(saved as never)); });
  });

  let accepted: boolean | undefined;
  await act(async () => {
    void hook.client.refetchQueries({ queryKey, exact: true });
    void hook.result.current.enqueue("Next step").then(result => { accepted = result; });
  });
  expect(stalePollSignal?.aborted).toBe(true);
  expect(accepted).toBe(true);
  expect(hook.client.getQueryData(queryKey)).toEqual({ messages: [{ id: "canonical", text: "Next step" }], paused: false });

  await act(async () => { readers[0]?.(); });
  expect(hook.client.getQueryData(queryKey)).toMatchObject({ messages: [{ id: "canonical" }] });
  hook.unmount();
  hook.client.clear();
  readers.slice(1).forEach(resolve => resolve());
});

it("keeps the enqueue locked and consumes the saved draft when the composer remounts", async () => {
  const first = open();
  const queueKey = "owner:thread";
  const draftKey = "relay-web.draft:owner:thread";
  const text = "Submit once";
  sessionStorage.setItem(draftKey, text);
  await waitFor(() => expect(first.client.isFetching()).toBe(0));

  let confirm!: () => void;
  const post = vi.fn(() => new Promise(resolve => {
    confirm = () => resolve({ messages: [{ id: "saved", text }], paused: false });
  }));
  vi.mocked(apiJson).mockImplementation(async (_path, options) => (
    options?.method === "POST" ? await post() : saved
  ) as never);

  let sent!: Promise<boolean>;
  await act(async () => { sent = first.result.current.enqueue(text); });
  first.unmount();
  const reopened = open(queueKey, false, first.client);
  let duplicate!: Promise<boolean>;
  act(() => { duplicate = reopened.result.current.enqueue(text); });
  expect(post).toHaveBeenCalledTimes(1);
  expect(reopened.result.current.pending).toBe(true);
  await expect(duplicate).resolves.toBe(false);

  await act(async () => {
    confirm();
    expect(await sent).toBe(true);
  });
  expect(sessionStorage.getItem(draftKey)).toBeNull();
  reopened.unmount();
  first.client.clear();
});
