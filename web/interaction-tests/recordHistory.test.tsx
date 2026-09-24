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

function renderHistory() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RecordHistory taskId="task_1" />
    </QueryClientProvider>,
  );
}

it("renders the history as an ordered list, newest first, with machine-readable times", async () => {
  renderHistory();
  const list = await screen.findByRole("list");
  expect(list.tagName).toBe("OL");
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  const times = items.map((item) => item.querySelector("time")?.getAttribute("dateTime"));
  expect(times).toEqual(["2026-06-02T09:00:00.000Z", "2026-06-01T09:00:00.000Z"]);
});

it("keeps the marker and rail decorative", async () => {
  renderHistory();
  const [first] = within(await screen.findByRole("list")).getAllByRole("listitem");
  const parts = first.querySelectorAll(".record-timeline-marker, .record-timeline-rail");
  expect(parts).toHaveLength(2);
  for (const part of parts) expect(part.getAttribute("aria-hidden")).toBe("true");
});

it("links an entry that ran in a thread to that thread", async () => {
  renderHistory();
  const [running] = within(await screen.findByRole("list")).getAllByRole("listitem");
  expect(within(running).getByRole("link", { name: "backlog.open_thread" })).toBeTruthy();
});
