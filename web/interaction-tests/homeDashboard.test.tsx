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
