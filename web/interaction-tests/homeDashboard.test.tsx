import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { HomeQueueItem } from "../src/components/home/HomeQueueItem";
import { MyTasksPanel } from "../src/components/home/HomePanels";
import type { HomeItem } from "../src/lib/homeQueue";
import type { HomeActions } from "../src/components/home/useHomeActions";

it("keeps a failed answer for retry and clears it after success", async () => {
  const answerWait = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const onResolved = vi.fn();
  const item = {
    kind: "wait", key: "task:t", stamp: "now", tier: "needs_you", since: "now",
    task: { id: "t", title: "Choose a plan" },
    awaiting: { kind: "question", questionId: "q", sessionId: "s", text: "Which plan?", options: [], notes: [], resumable: true },
  } as HomeItem;
  render(<HomeQueueItem item={item} actions={{ answerWait } as unknown as HomeActions}
    agentName={() => null} projectName={() => null} since="now" href="/tasks/t"
    onOpen={vi.fn()} onResolved={onResolved} />);
  const user = userEvent.setup();
  const input = screen.getByRole("textbox");
  await user.type(input, "Use the annual plan");
  await user.click(screen.getByRole("button", { name: "home.send" }));
  expect((input as HTMLInputElement).value).toBe("Use the annual plan");
  expect(onResolved).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "home.send" }));
  expect(answerWait).toHaveBeenNthCalledWith(2, "s", "q", "Use the annual plan", undefined);
  expect((input as HTMLInputElement).value).toBe("");
  expect(onResolved).toHaveBeenCalledOnce();
});

it("shows personal stage counts without misleading drill-down links", () => {
  render(<MyTasksPanel counts={{ backlog: 1, assigned: 2, running: 3, review: 4, doneThisWeek: 5 }} />);
  expect(screen.getByText("home.count.running")).toBeTruthy();
  expect(screen.queryAllByRole("link")).toHaveLength(0);
});

it("keeps Start available after a network failure and prevents duplicate submissions", async () => {
  const { ReadyTask } = await import("../src/components/home/HomePlanningPanels");
  const task = { id: "ready", title: "Ready work", priority: "high" } as import("../src/types").RelayTaskListItem;
  let finish!: (value: import("../src/types").StartTaskResponse) => void;
  const pending = new Promise<import("../src/types").StartTaskResponse>(resolve => { finish = resolve; });
  const onStart = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockReturnValueOnce(pending);
  render(<ReadyTask task={task} href="/tasks/ready" onOpen={vi.fn()} onStart={onStart} />);
  const user = userEvent.setup();
  const start = screen.getByRole("button", { name: "home.plan.start" }) as HTMLButtonElement;
  await user.click(start);
  expect(screen.getByRole("status").textContent).toContain("home.plan.start_error");
  expect(start.disabled).toBe(false);
  await user.dblClick(start);
  expect(onStart).toHaveBeenCalledTimes(2);
  expect(start.disabled).toBe(true);
  const { act } = await import("@testing-library/react");
  await act(async () => { finish({ task, session: null, dispatch: {state: "queued"} } as import("../src/types").StartTaskResponse); });
  expect(screen.getByRole("status").textContent).toContain("home.plan.start_queued");
  expect(start.disabled).toBe(true);
});
