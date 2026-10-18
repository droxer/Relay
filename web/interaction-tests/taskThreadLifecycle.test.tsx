import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

import * as api from "../src/api";
import { TaskLifecycleMarker } from "../src/components/TaskLifecycleMarker";
import { useTaskThreadLifecycle } from "../src/hooks/useTaskThreadLifecycle";
import type { LifecycleMarker } from "../src/lib/taskThreadLifecycle";
import type { RelayTaskEvent, RelayTaskListItem } from "../src/types";

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

it("says what changed, who changed it, and when", () => {
  render(<TaskLifecycleMarker marker={marker({})} current={false} />);
  expect(screen.getByText("thread.lifecycle.to_review")).toBeTruthy();
  expect(screen.getByText(/thread\.lifecycle\.by_relay/)).toBeTruthy();
  expect(document.querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-18T10:00:00.000Z");
});

it("names a person's acceptance and a resume by where the task came from", () => {
  const { rerender } = render(
    <TaskLifecycleMarker marker={marker({ from: "review", to: "done", actor: "you" })} current={false} />,
  );
  expect(screen.getByText("thread.lifecycle.accepted")).toBeTruthy();
  rerender(<TaskLifecycleMarker marker={marker({ from: "waiting_for_human", to: "running" })} current={false} />);
  expect(screen.getByText("thread.lifecycle.resumed")).toBeTruthy();
  rerender(<TaskLifecycleMarker marker={marker({ from: "blocked", to: "assigned", actor: "teammate" })} current={false} />);
  expect(screen.getByText("thread.lifecycle.unblocked · backlog.statuses.assigned")).toBeTruthy();
});

it("shows a blocker's reason and, on the current move, the next step with a link to the task", () => {
  const onOpenTask = vi.fn();
  render(
    <TaskLifecycleMarker
      marker={marker({ to: "blocked", reason: "Computer offline" })}
      current
      taskHref="/issues/tsk_1"
      taskLabel="#12"
      onOpenTask={onOpenTask}
    />,
  );
  expect(screen.getByText("Computer offline")).toBeTruthy();
  expect(screen.getByText(/thread\.lifecycle\.next_blocked/)).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "#12" }));
  expect(onOpenTask).toHaveBeenCalledOnce();
});

it("gives no next step to a move the task has already left", () => {
  render(<TaskLifecycleMarker marker={marker({ to: "blocked" })} current={false} taskHref="/x" taskLabel="#12" onOpenTask={() => {}} />);
  expect(screen.queryByText(/thread\.lifecycle\.next_/)).toBeNull();
});

it("resolves the thread's task, places its moves between turns, and marks the current one", async () => {
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
    messages: [
      { id: "goal", timestamp: "2026-10-18T10:00:00.000Z" },
      { id: "turn", timestamp: "2026-10-18T10:00:02.000Z" },
    ],
    currentUserId: "usr_me",
    onOpenTaskRecord,
  }), { wrapper });

  await waitFor(() => expect(result.current.trailing).toHaveLength(1));
  expect(result.current.task?.ref).toBe("#12");
  expect(result.current.task?.status).toBe("review");
  expect(result.current.before.get("goal")?.map((m) => [m.to, m.actor])).toEqual([["assigned", "you"]]);
  expect(result.current.before.get("turn")?.map((m) => m.to)).toEqual(["running"]);
  expect(result.current.currentMarkerId).toBe("e3");
  result.current.task?.onOpen();
  expect(onOpenTaskRecord).toHaveBeenCalledWith({ taskId: "tsk_1" });
});

it("gives a thread no task nothing to draw", () => {
  const spy = vi.spyOn(api, "listTaskEvents");
  const { result } = renderHook(() => useTaskThreadLifecycle({
    tasks: [],
    session: { id: "ses_9", createdAt: "2026-10-18T10:00:00.000Z" },
    messages: [],
    currentUserId: "usr_me",
  }), { wrapper });
  expect(result.current.task).toBeUndefined();
  expect(result.current.trailing).toEqual([]);
  expect(spy).not.toHaveBeenCalled();
});
