import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import * as api from "../src/api";
import { TaskStatusTimeline } from "../src/components/TaskStatusTimeline";
import { TaskActionBar, taskNeedsAction } from "../src/components/TaskActionBar";
import { useTaskThreadLifecycle } from "../src/hooks/useTaskThreadLifecycle";
import type { LifecycleMarker } from "../src/lib/taskThreadLifecycle";
import type { RelayTaskEvent, RelayTaskListItem, TaskStatus } from "../src/types";
import type { ThreadTaskFact } from "../src/components/ThreadMeta";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

const marker = (partial: Partial<LifecycleMarker>): LifecycleMarker => ({
  id: "evt",
  timestamp: "2026-10-18T10:00:00.000Z",
  from: "running",
  to: "review",
  actor: "relay",
  ...partial,
});

// The history renders a relative time for a recent move and a date past a
// day, so the clock is pinned beside the fixture's timestamps; without it the
// first assertion below started failing the day after the fixture was written.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const task = (status: TaskStatus, onOpen = () => {}, extra: Partial<ThreadTaskFact> = {}): ThreadTaskFact => ({ id: "tsk_1", ref: "#12", status, current: true, href: "/issues/tsk_1", onOpen, ...extra });

it("leads with where the task stands, then lists each move and when", () => {
  render(<TaskStatusTimeline task={task("done")} markers={[marker({}), marker({ id: "b", from: "review", to: "done", actor: "you" })]} />);
  const region = screen.getByRole("region", { name: "thread.lifecycle.label" });
  expect(region.querySelector(".task-status-now")?.textContent).toBe("backlog.statuses.done");
  const steps = screen.getAllByRole("listitem");
  // Relay's own move names no actor; a person's does.
  expect(steps[0].textContent).toMatch(/^thread\.lifecycle\.to_review\d/);
  expect(steps[1].textContent).toMatch(/thread\.lifecycle\.accepted.*thread\.lifecycle\.by_you · /);
  expect(steps[0].querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-18T10:00:00.000Z");
});

it("names a resume and an unblock by where the task came from", () => {
  render(
    <TaskStatusTimeline
      task={task("assigned")}
      markers={[
        marker({ id: "b", from: "waiting_for_human", to: "running" }),
        marker({ id: "c", from: "blocked", to: "assigned", actor: "teammate" }),
      ]}
    />,
  );
  expect(screen.getByText("thread.lifecycle.resumed")).toBeTruthy();
  expect(screen.getByText("thread.lifecycle.unblocked · backlog.statuses.assigned")).toBeTruthy();
});

it("says why a task is blocked, what to do, offers the move, and links to the task", () => {
  const onOpen = vi.fn();
  render(
    <TaskStatusTimeline
      task={task("blocked", onOpen, { blockerReason: "Computer offline" })}
      markers={[]}
      actions={<button type="button">Unblock</button>}
    />,
  );
  expect(screen.getByText("Computer offline")).toBeTruthy();
  expect(screen.getByText("thread.lifecycle.next_blocked")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Unblock" })).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "#12" }));
  expect(onOpen).toHaveBeenCalledOnce();
});

it("gives running work no next step", () => {
  render(<TaskStatusTimeline task={task("running")} markers={[marker({ to: "running" })]} />);
  expect(screen.queryByText(/thread\.lifecycle\.next_/)).toBeNull();
});

it("docks a bar only for work that waits on a person", () => {
  expect(["review", "blocked"].filter(taskNeedsAction)).toEqual(["review", "blocked"]);
  expect(["running", "waiting_for_human", "done", "assigned"].some(taskNeedsAction)).toBe(false);
});

it("accepts a reviewed task in one click, and asks for changes through the composer", () => {
  const onAccept = vi.fn();
  const onReply = vi.fn();
  render(<TaskActionBar task={task("review")} busy={null} onAccept={onAccept} onUnblock={() => {}} onReply={onReply} />);
  expect(screen.getByRole("region").textContent).toContain("#12 thread.lifecycle.bar_review");
  fireEvent.click(screen.getByRole("button", { name: "thread.lifecycle.accept" }));
  fireEvent.click(screen.getByRole("button", { name: "thread.lifecycle.request_changes" }));
  expect(onAccept).toHaveBeenCalledOnce();
  expect(onReply).toHaveBeenCalledOnce();
});

it("steps Accept down to outline while a turn decision holds the view's primary", () => {
  const { rerender } = render(<TaskActionBar task={task("review")} busy={null} onAccept={() => {}} onUnblock={() => {}} onReply={() => {}} />);
  const accept = () => screen.getByRole("button", { name: "thread.lifecycle.accept" });
  expect(accept().getAttribute("data-variant")).toBe("default");
  rerender(<TaskActionBar task={task("review")} busy={null} deferPrimary onAccept={() => {}} onUnblock={() => {}} onReply={() => {}} />);
  expect(accept().getAttribute("data-variant")).toBe("outline");
});

it("offers to lift a block, and holds its controls while a move is in flight", () => {
  const onUnblock = vi.fn();
  const { rerender } = render(<TaskActionBar task={task("blocked", () => {}, { blockerReason: "No disk" })} busy={null} onAccept={() => {}} onUnblock={onUnblock} onReply={() => {}} />);
  expect(screen.getByText(/No disk/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "thread.lifecycle.unblock" }));
  expect(onUnblock).toHaveBeenCalledOnce();
  rerender(<TaskActionBar task={task("blocked")} busy="unblock" onAccept={() => {}} onUnblock={onUnblock} onReply={() => {}} />);
  expect((screen.getByRole("button", { name: "thread.lifecycle.unblock" }) as HTMLButtonElement).disabled).toBe(true);
});

it("resolves the thread's task and its moves here", async () => {
  const events: RelayTaskEvent[] = [
    { id: "e1", type: "task.status", taskId: "tsk_1", timestamp: "2026-10-18T09:59:00.000Z", status: "assigned", actorUserId: "usr_me" },
    { id: "e2", type: "task.status", taskId: "tsk_1", timestamp: "2026-10-18T10:00:01.000Z", status: "running" },
    { id: "e3", type: "task.status", taskId: "tsk_1", timestamp: "2026-10-18T10:05:00.000Z", status: "review" },
  ];
  vi.spyOn(api, "listTaskEvents").mockResolvedValue({ events } as Awaited<ReturnType<typeof api.listTaskEvents>>);
  const task = { id: "tsk_1", number: 12, title: "Ship", status: "review", isRoutine: false, linkedSessionIds: ["ses_1"] } as unknown as RelayTaskListItem;
  const onOpenTaskRecord = vi.fn();

  const { result } = renderHook(() => useTaskThreadLifecycle({
    tasks: [task],
    session: { id: "ses_1", createdAt: "2026-10-18T10:00:00.000Z" },
    currentUserId: "usr_me",
    onOpenTaskRecord,
  }), { wrapper });

  await waitFor(() => expect(result.current.markers).toHaveLength(3));
  expect(result.current.task?.ref).toBe("#12");
  expect(result.current.task?.status).toBe("review");
  // Its newest thread is the one its moves are made from.
  expect(result.current.task?.current).toBe(true);
  expect(result.current.markers.map((m) => [m.to, m.actor])).toEqual([["assigned", "you"], ["running", "relay"], ["review", "relay"]]);
  result.current.task?.onOpen();
  expect(onOpenTaskRecord).toHaveBeenCalledWith({ taskId: "tsk_1" });
});

it("gives a thread no task nothing to draw", () => {
  const spy = vi.spyOn(api, "listTaskEvents");
  const { result } = renderHook(() => useTaskThreadLifecycle({
    tasks: [],
    session: { id: "ses_9", createdAt: "2026-10-18T10:00:00.000Z" },
    currentUserId: "usr_me",
  }), { wrapper });
  expect(result.current.task).toBeUndefined();
  expect(result.current.markers).toEqual([]);
  expect(spy).not.toHaveBeenCalled();
});
