import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { HomeQueueItem } from "../src/components/home/HomeQueueItem";
import { HomeQueue } from "../src/components/home/HomeQueue";
import { MyTasksPanel } from "../src/components/home/HomePanels";
import type { HomeItem } from "../src/lib/homeQueue";
import type { HomeActions } from "../src/components/home/useHomeActions";

it("opens the Start here thread without composing or sending a reply", async () => {
  const answerWait = vi.fn();
  const onOpen = vi.fn();
  const item = {
    kind: "wait", key: "task:t", stamp: "now", tier: "needs_you", since: "now",
    task: { id: "t", title: "Choose a plan" },
    awaiting: { kind: "question", questionId: "q", sessionId: "s", text: "Which plan?", options: ["Annual", "Monthly"], notes: [], resumable: true },
  } as HomeItem;
  render(<HomeQueue items={[item]} actions={{ answerWait } as unknown as HomeActions}
    agentName={() => null} projectName={() => null} sinceLabel={() => "now"}
    hrefFor={() => "/threads/s"} onOpen={onOpen} allTasksHref="/tasks" onOpenAllTasks={vi.fn()} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Annual" })).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "home.open_thread" }));
  expect(onOpen).toHaveBeenCalledWith(item);
  expect(answerWait).not.toHaveBeenCalled();
});

it("takes every Up next row to its thread instead of acting from Home", async () => {
  const answerPermission = vi.fn();
  const onOpen = vi.fn();
  const item = {
    kind: "permission", key: "permission:s:r", stamp: "now", tier: "paused", since: "now",
    session: { id: "s", title: "Migrate billing" },
    request: { id: "r", toolName: "Bash", input: "rm -rf build", agent: "claude" },
  } as unknown as HomeItem;
  render(<HomeQueueItem item={item} actions={{ answerPermission } as unknown as HomeActions}
    agentName={() => null} projectName={() => null} since="now" href="/threads/s"
    onOpen={onOpen} onResolved={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "home.allow" })).toBeNull();
  expect(screen.queryByRole("button", { name: "home.deny" })).toBeNull();
  // Below Start here a row carries no Open button; its title is the way in.
  expect(screen.queryByRole("button", { name: "home.open_thread" })).toBeNull();
  await userEvent.setup().click(screen.getByRole("link", { name: "Migrate billing" }));
  expect(onOpen).toHaveBeenCalledOnce();
  expect(answerPermission).not.toHaveBeenCalled();
});

it("links each status count to the Tasks queue that lists exactly those tasks", () => {
  const hrefFor = (queue: string) => `/tasks?queue=${queue}&assignee=me`;
  render(<MyTasksPanel counts={{ open: 4, running: 1, blocked: 2, doneThisWeek: 5 }} hrefFor={hrefFor} onOpen={vi.fn()} />);
  const links = screen.getAllByRole("link");
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/tasks?queue=open&assignee=me",
    "/tasks?queue=running&assignee=me",
    "/tasks?queue=blocked&assignee=me",
  ]);
  // No queue holds only this week's finished work, so that count opens nothing.
  expect(screen.getByText("home.count.doneThisWeek").closest("a")).toBeNull();
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
