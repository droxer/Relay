import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RecordHistory } from "../src/components/task-record/RecordHistory";

const { listTaskEvents } = vi.hoisted(() => ({
  listTaskEvents: vi.fn(async () => ({
    events: [
      { id: "e1", taskId: "task_1", type: "task.created", timestamp: "2026-06-01T09:00:00.000Z" },
      {
        id: "e2", taskId: "task_1", type: "task.activity", timestamp: "2026-06-02T09:00:00.000Z",
        activity: { id: "act_1", createdAt: "2026-06-02T09:00:00.000Z", message: "Dispatched to claude", sessionId: "session_1" },
      },
    ],
  })),
}));
vi.mock("../src/api", () => ({ listTaskEvents }));

function renderHistory(currentUserId?: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RecordHistory taskId="task_1" currentUserId={currentUserId} />
    </QueryClientProvider>,
  );
}

it("renders each day as an ordered list, newest day and line first, with machine-readable times", async () => {
  renderHistory();
  const lists = await screen.findAllByRole("list");
  expect(lists.map((list) => list.tagName)).toEqual(["OL", "OL"]);
  // Each day is a labelled group, so the date is said once rather than per line.
  expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(2);
  const times = lists.flatMap((list) =>
    within(list).getAllByRole("listitem").map((item) => item.querySelector("time")?.getAttribute("dateTime")));
  expect(times).toEqual(["2026-06-02T09:00:00.000Z", "2026-06-01T09:00:00.000Z"]);
});

it("keeps the marker decorative", async () => {
  renderHistory();
  const [first] = within((await screen.findAllByRole("list"))[0]!).getAllByRole("listitem");
  const marker = first!.querySelector(".record-timeline-marker");
  expect(marker?.getAttribute("aria-hidden")).toBe("true");
});

it("links an entry that ran in a thread to that thread", async () => {
  renderHistory();
  const [running] = within((await screen.findAllByRole("list"))[0]!).getAllByRole("listitem");
  expect(within(running!).getByRole("link", { name: "backlog.open_thread" })).toBeTruthy();
});

it("says a status move the way the thread does, with who made it and why", async () => {
  listTaskEvents.mockResolvedValueOnce({
    events: [
      { id: "s1", taskId: "task_1", type: "task.status", timestamp: "2026-06-03T09:00:00.000Z", status: "running" },
      { id: "s2", taskId: "task_1", type: "task.status", timestamp: "2026-06-03T09:10:00.000Z", status: "waiting_for_human", reason: "Which release?" },
      { id: "s3", taskId: "task_1", type: "task.status", timestamp: "2026-06-03T09:20:00.000Z", status: "running", actorUserId: "u-1" },
    ],
  } as never);
  renderHistory("u-1");
  const items = within(await screen.findByRole("list")).getAllByRole("listitem");
  // A resume is not a fresh start, and the reader's own move says so.
  expect(items[0]!.textContent).toContain("thread.lifecycle.resumed");
  expect(items[0]!.textContent).toContain("thread.lifecycle.by_you");
  // The question the run stopped on is kept, not dropped.
  expect(items[1]!.textContent).toContain("thread.lifecycle.to_waiting_for_human");
  expect(items[1]!.querySelector(".record-timeline-detail")?.textContent).toBe("Which release?");
  // Relay's own moves name no actor.
  expect(items[2]!.textContent).toContain("thread.lifecycle.to_running");
  expect(items[2]!.textContent).not.toContain("thread.lifecycle.by_");
  // A move wears the task's status glyph; bookkeeping lines only a dot.
  expect(items[1]!.querySelector(".task-status-icon")?.getAttribute("data-status")).toBe("waiting_for_human");
});
