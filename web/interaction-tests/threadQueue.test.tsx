import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useThreadQueue } from "../src/hooks/useThreadQueue";
import { apiJson } from "../src/api-client/client";
import { setSessionStreamConnected } from "../src/lib/sessionStreamStatus";
import { THREAD_QUEUE_QUERY_KEY } from "../src/lib/threadQueue";

vi.mock("../src/api-client/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/api-client/client")>(), apiJson: vi.fn(),
}));
vi.mock("../src/api-client/sessions", () => ({ cancelRun: vi.fn(async () => ({})) }));
let saved: { messages: { id: string; text: string }[]; paused: boolean };
beforeEach(() => {
  setSessionStreamConnected(false);
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
it("renders pushed queue changes without polling the connected thread", async () => {
  vi.useFakeTimers();
  vi.mocked(apiJson).mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = [...THREAD_QUEUE_QUERY_KEY, "thread"];
  client.setQueryData(key, { messages: [], paused: false });
  setSessionStreamConnected(true, "thread");
  const hook = open("owner:thread", true, client);
  try {
    await act(() => vi.advanceTimersByTimeAsync(7_000));
    expect(apiJson).not.toHaveBeenCalled();
    act(() => { client.setQueryData(key, { messages: [{ id: "other", text: "From another tab" }], paused: false }); });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.messages.map(message => message.id)).toEqual(["other"]);
    act(() => setSessionStreamConnected(false, "thread"));
    await act(() => vi.advanceTimersByTimeAsync(1_010));
    expect(apiJson).toHaveBeenCalledTimes(1);
    expect(hook.result.current.messages).toEqual([]);
  } finally {
    hook.unmount();
    client.clear();
    setSessionStreamConnected(false);
    vi.useRealTimers();
  }
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

it("keeps the enqueue pending and reuses its message ID after losing the response", async () => {
  const send = await vi.importActual<typeof import("../src/api-client/client")>("../src/api-client/client");
  const read = vi.mocked(apiJson).getMockImplementation()!;
  vi.mocked(apiJson).mockImplementation((path, options) => options?.method === "POST"
    ? send.apiJson(path, options)
    : read(path, options));
  const bodies: string[] = [];
  const receipt = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(body);
    const { id, text } = JSON.parse(body);
    if (!saved.messages.some(message => message.id === id)) saved.messages.push({ id, text });
    if (bodies.length === 1) throw new TypeError("Connection closed");
    return receipt.promise;
  });
  const hook = open();
  let accepted: Promise<boolean> | undefined;
  await act(async () => { accepted = hook.result.current.enqueue("Keep going"); });
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(hook.result.current.pending).toBe(true);
  expect(hook.result.current.error).toBeNull();
  await act(async () => {
    receipt.resolve(Response.json(saved));
    expect(await accepted).toBe(true);
  });
  await waitFor(() => expect(hook.result.current.pending).toBe(false));
  expect(bodies).toEqual([bodies[0], bodies[0]]);
  expect(hook.result.current.messages).toEqual(saved.messages);
  expect(saved.messages).toHaveLength(1);
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
  act(() => hook.result.current.messageRetry?.dismiss());
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
  expect(apiJson).toHaveBeenCalledWith("/threads/thread/queue?view=versioned", expect.objectContaining({
    body: expect.objectContaining({ action: "steer", id: "q1" }),
  }));
  expect(cancelRun).not.toHaveBeenCalled();
  vi.mocked(apiJson).mockRejectedValueOnce(new Error("Private server error"));
  await act(async () => { await hook.result.current.steer("q1"); });
  expect(hook.result.current.error).toBe("queue.errors.change_failed");
});

it("shows a message handed to the live run as sending until its computer answers", async () => {
  const until = new Date(Date.now() + 60_000).toISOString();
  vi.mocked(apiJson).mockResolvedValue({ messages: [{ id: "q1", text: "Use staging" }], paused: false, live: { id: "q1", until } } as any);
  const hook = open();
  await waitFor(() => expect(hook.result.current.sending).toBe("q1"));
});

it("treats a handed-over message whose answer window passed as queued again", async () => {
  const until = new Date(Date.now() - 1_000).toISOString();
  vi.mocked(apiJson).mockResolvedValue({ messages: [{ id: "q1", text: "Use staging" }], paused: false, live: { id: "q1", until } } as any);
  const hook = open();
  await waitFor(() => expect(hook.result.current.messages).toHaveLength(1));
  expect(hook.result.current.sending).toBeUndefined();
});

it("promotes a message without requesting Stop when the thread is idle", async () => {
  const hook = open("owner:thread", false);
  await waitFor(() => expect(apiJson).toHaveBeenCalled());
  await act(async () => { await hook.result.current.steer("q1"); });
  expect(apiJson).toHaveBeenCalledWith("/threads/thread/queue?view=versioned", expect.objectContaining({
    body: expect.objectContaining({ action: "promote", id: "q1" }),
  }));
});

it("offers persisted undo and resumes through the same server queue", async () => {
  const removedAt = new Date().toISOString();
  vi.mocked(apiJson).mockResolvedValue({ messages: [], paused: true, removed: { message: { id: "old", text: "Saved" }, beforeId: null, removedAt } });
  const hook = open();
  await waitFor(() => expect(hook.result.current.removedAt).toBe(removedAt));
  await act(async () => { hook.result.current.undoRemove(); });
  expect(apiJson).toHaveBeenCalledWith("/threads/thread/queue?view=versioned", expect.objectContaining({ body: expect.objectContaining({ action: "undo_remove", id: "old" }) }));
  await act(async () => { hook.result.current.resume(); });
  expect(apiJson).toHaveBeenCalledWith("/threads/thread/queue?view=versioned", expect.objectContaining({ body: expect.objectContaining({ action: "resume" }) }));
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

it("reuses the original enqueue after a lost receipt and reload", async () => {
  const original = open();
  await waitFor(() => expect(original.client.isFetching()).toBe(0));
  const reply = vi.mocked(apiJson).getMockImplementation()!;
  let firstPost = true;
  const posts: unknown[] = [];
  vi.mocked(apiJson).mockImplementation(async (path, options) => {
    if (options?.method !== "POST") return reply(path, options);
    posts.push(options.body);
    const accepted = await reply(path, options);
    if (firstPost) {
      firstPost = false;
      throw new TypeError("Receipt lost");
    }
    return accepted;
  });
  await act(async () => {
    expect(await original.result.current.enqueue("Keep going", { addressAgentIds: ["selected"] })).toBe(false);
  });
  original.unmount();
  original.client.clear();

  const reloaded = open();
  expect(reloaded.result.current.messageRetry?.text).toBe("Keep going");
  await act(async () => { expect(await reloaded.result.current.messageRetry!.retry()).toBe(true); });
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(saved.messages).toHaveLength(1);
  expect(reloaded.result.current.messageRetry).toBeNull();
});
