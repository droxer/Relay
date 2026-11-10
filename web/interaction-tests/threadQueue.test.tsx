import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ComposerHandle } from "../src/components/composer/Composer";
import { useThreadQueue } from "../src/hooks/useThreadQueue";
import { useThreadQueueStore } from "../src/lib/threadQueueStore";

function composer(sendResult = true) {
  let text = "";
  const handle: ComposerHandle = {
    clear: () => { text = ""; },
    focus: vi.fn(),
    getText: () => text,
    setText: (next) => { text = next; },
    send: vi.fn(async () => sendResult),
  };
  return { ref: { current: handle }, handle };
}

type Props = { running: boolean; awaitsPerson: boolean; queueKey: string };

function render(handle: ReturnType<typeof composer>, onCancelRun = vi.fn(), initial: Props = { running: true, awaitsPerson: false, queueKey: "thread-1" }) {
  return renderHook((props: Props) => useThreadQueue({ ...props, composerRef: handle.ref, onCancelRun }), { initialProps: initial });
}

beforeEach(() => {
  sessionStorage.clear();
  useThreadQueueStore.setState({ queues: {} });
});

it("queues mid-run and sends the head as typed once the run ends", async () => {
  const c = composer();
  const { result, rerender } = render(c);
  act(() => { result.current.enqueue("@Ada also fix the tests"); result.current.enqueue("then update docs"); });
  expect(result.current.messages.map((m) => m.text)).toEqual(["@Ada also fix the tests", "then update docs"]);
  expect(c.handle.send).not.toHaveBeenCalled();

  rerender({ running: false, awaitsPerson: false, queueKey: "thread-1" });
  await waitFor(() => expect(c.handle.send).toHaveBeenCalledWith("@Ada also fix the tests", expect.objectContaining({ asTyped: true })));
  await waitFor(() => expect(result.current.messages.map((m) => m.text)).toEqual(["then update docs"]));
  expect(JSON.parse(sessionStorage.getItem("relay-web.queue:thread-1")!)).toHaveLength(1);
});

it("steer moves the pick to the head, stops the run, and sends it when the run settles", async () => {
  const c = composer();
  const onCancelRun = vi.fn();
  const { result, rerender } = render(c, onCancelRun);
  act(() => { result.current.enqueue("first"); result.current.enqueue("change of plan"); });
  const picked = result.current.messages[1]!.id;

  act(() => result.current.steer(picked));
  expect(onCancelRun).toHaveBeenCalledTimes(1);
  expect(result.current.messages[0]!.text).toBe("change of plan");

  // A question would hold an ordinary drain; a steer is the person's choice.
  rerender({ running: false, awaitsPerson: true, queueKey: "thread-1" });
  await waitFor(() => expect(c.handle.send).toHaveBeenCalledWith("change of plan", expect.objectContaining({ asTyped: true })));
});

it("holds the queue after a plain Stop or while the person is asked", async () => {
  const c = composer();
  const { result, rerender } = render(c);
  act(() => result.current.enqueue("later"));
  act(() => result.current.stop());
  rerender({ running: false, awaitsPerson: false, queueKey: "thread-1" });

  rerender({ running: true, awaitsPerson: false, queueKey: "thread-1" });
  rerender({ running: false, awaitsPerson: true, queueKey: "thread-1" });
  await act(async () => {});
  expect(c.handle.send).not.toHaveBeenCalled();
  expect(result.current.messages).toHaveLength(1);
});

it("puts a failed send back at the head and pauses", async () => {
  const c = composer(false);
  const { result, rerender } = render(c);
  act(() => { result.current.enqueue("one"); result.current.enqueue("two"); });
  rerender({ running: false, awaitsPerson: false, queueKey: "thread-1" });
  await waitFor(() => expect(c.handle.send).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(result.current.messages.map((m) => m.text)).toEqual(["one", "two"]));
  rerender({ running: true, awaitsPerson: false, queueKey: "thread-1" });
  expect(c.handle.send).toHaveBeenCalledTimes(1);
});

it("never sends on opening a thread, and edit returns the text to the box", async () => {
  sessionStorage.setItem("relay-web.queue:thread-2", JSON.stringify([{ id: "q1", text: "left over" }]));
  const c = composer();
  c.handle.setText("draft");
  const { result } = render(c, vi.fn(), { running: false, awaitsPerson: false, queueKey: "thread-2" });
  expect(result.current.messages.map((m) => m.text)).toEqual(["left over"]);
  expect(c.handle.send).not.toHaveBeenCalled();

  act(() => result.current.edit("q1"));
  expect(c.handle.getText()).toBe("draft\n\nleft over");
  expect(result.current.messages).toEqual([]);
});


it("drains B independently while A's queued send is pending", async () => {
  const c = composer();
  let finishA!: (sent: boolean) => void;
  vi.mocked(c.handle.send).mockReturnValueOnce(new Promise<boolean>(resolve => { finishA = resolve; }));
  const { result, rerender } = render(c);
  act(() => result.current.enqueue("A message"));
  rerender({ queueKey: "thread-1", running: false, awaitsPerson: false });
  expect(c.handle.send).toHaveBeenCalledTimes(1);
  rerender({ queueKey: "B", running: true, awaitsPerson: false });
  act(() => result.current.enqueue("B message"));
  rerender({ queueKey: "B", running: false, awaitsPerson: false });
  await act(async () => { finishA(true); });
  expect(c.handle.send).toHaveBeenCalledTimes(2);
  expect(c.handle.send).toHaveBeenLastCalledWith("B message", expect.objectContaining({ asTyped: true }));
});

it("A's late completion cannot undo B's Stop", async () => {
  const c = composer();
  let finishA!: (sent: boolean) => void;
  vi.mocked(c.handle.send).mockReturnValueOnce(new Promise<boolean>(resolve => { finishA = resolve; }));
  const { result, rerender } = render(c);
  act(() => result.current.enqueue("A message"));
  rerender({ queueKey: "thread-1", running: false, awaitsPerson: false });
  rerender({ queueKey: "B", running: true, awaitsPerson: false });
  act(() => { result.current.enqueue("B message"); result.current.stop(); });
  await act(async () => { finishA(true); });
  rerender({ queueKey: "B", running: false, awaitsPerson: false });
  expect(c.handle.send).toHaveBeenCalledTimes(1);
  expect(result.current.messages.map(message => message.text)).toEqual(["B message"]);
});
