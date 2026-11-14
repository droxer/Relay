import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ThreadRow } from "../src/components/ThreadRow";
import type { RelaySession, RelayTaskListItem, SessionSummary } from "../src/types";
import type { ThreadItem } from "../src/lib/threads";
import { groupThreads } from "../src/lib/threadGroups";
import { mergeSessionSummaries } from "../src/lib/sessionPollMerge";

// The shared setup's `t` drops interpolation; this file asserts the name that
// fills `{{agent}}`, so its `t` keeps it.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { agent?: string }) => (options?.agent ? `${key}:${options.agent}` : key),
    i18n: { language: "en" },
  }),
}));

function session(id: string, status: string, extra: Partial<RelaySession> = {}): RelaySession {
  return {
    id,
    taskGoal: `Thread ${id}`,
    status,
    updatedAt: "2026-09-01T00:00:00Z",
    agentRuns: [],
    ...extra,
  } as unknown as RelaySession;
}

function renderRow(item: ThreadItem, tone: "attn" | "run" | "idle", layout: "full" | "nested" = "full") {
  const { container } = render(
    <ul>
      <ThreadRow
        item={item}
        tone={tone}
        layout={layout}
        selected={false}
        onSelect={vi.fn()}
        now={Date.parse("2026-09-01T00:05:00Z")}
      />
    </ul>,
  );
  return container;
}

it("keeps a done task's summary row out of needsYou with no waiting subline", () => {
  const [thread] = mergeSessionSummaries([], [{
    ...session("done-task", "completed"), workOutcome: "blocked",
    eventCount: 10, runCount: 1, artifactCount: 0,
  } as SessionSummary]);
  const tasks = [{ id: "task", status: "done", linkedSessionIds: [thread.id] }] as RelayTaskListItem[];
  const item: ThreadItem = { session: thread, origin: { kind: "backlog", taskId: "task", ref: "#1", title: "Task", status: "done" } };
  const groups = groupThreads([item], tasks);
  expect(groups.needsYou).toHaveLength(0);
  expect(groups.idle).toEqual([item]);
  const container = renderRow(groups.idle[0], "idle");
  expect(container.querySelector(".task-status-icon")?.getAttribute("data-status")).toBe("done");
  expect(container.querySelector(".conversation-status")).toBeNull();
  expect(container.textContent).not.toContain("thread.statuses.waiting_for_human");
  expect(container.querySelector(".conversation-ref")?.textContent).toBe("#1");
});

it("shows no task number on a plain chat row", () => {
  const container = renderRow({ session: session("chat", "completed") }, "idle");
  expect(container.querySelector(".conversation-ref")).toBeNull();
});

it("marks a task thread's state, including when it is settled", () => {
  for (const [status, iconStatus] of [
    ["waiting_for_human", "waiting_for_human"],
    ["running", "running"],
    ["completed", "done"],
  ] as const) {
    const container = renderRow(
      { session: session(status, status), origin: { kind: "backlog", taskId: "task", ref: "#1", title: "Task" } },
      status === "waiting_for_human" ? "attn" : status === "running" ? "run" : "idle",
    );
    const marks = container.querySelectorAll(".task-status-icon");
    expect(marks.length).toBe(1);
    expect(marks[0].getAttribute("data-status")).toBe(iconStatus);
    // Both row layouts keep status icons aligned before the title.
    expect(container.querySelector(".conversation-topline")?.firstElementChild).toBe(marks[0]);
    screen.getByText(`Thread ${status}`);
  }
});

it("shows a conversation recovery badge when the computer is unresponsive", () => {
  const container = renderRow(
    { session: session("x", "running", { execution: { phase: "unresponsive" } as never }) },
    "run",
  );
  expect(container.querySelector(".task-status-icon")).toBeNull();
  expect(container.querySelector(".thread-status-badge")?.getAttribute("data-state")).toBe("unresponsive");
});

it("keeps failure and cancellation status for task threads", () => {
  const failed = renderRow({ session: session("f", "failed"), origin: { kind: "backlog", taskId: "task", ref: "#1", title: "Task" } }, "idle").querySelector(".task-status-icon");
  expect(failed?.getAttribute("data-status")).toBe("blocked");

  // Cancellation uses the same slashed ring as the task board.
  const cancelled = renderRow({ session: session("c", "cancelled"), origin: { kind: "routine", taskId: "auto", ref: "#1", title: "Automation" } }, "idle").querySelector(".task-status-icon");
  expect(cancelled?.getAttribute("data-status")).toBe("cancelled");
});

it("never draws the state twice on one row", () => {
  // A running row names its agent alongside a single status icon.
  const container = renderRow(
    { session: session("r", "running"), runningAgent: "claude" } as ThreadItem,
    "run",
  );
  expect(container.querySelectorAll(".thread-status-badge").length).toBe(1);
  expect(container.querySelector(".task-status-icon")).toBeNull();
  expect(container.querySelector(".conversation-subline")).toBeTruthy();
});

it("names the running agent, never its executor kind", () => {
  // Several named agents share one runtime, so "Claude is working" named
  // nobody — the row speaks the logical agent's name, or just "Running".
  const named = renderRow(
    { session: session("n", "running", { execution: { phase: "running" } as never }), runningAgent: "claude", runningAgentName: "Ada" },
    "run",
  );
  expect(named.querySelector(".conversation-status")?.textContent).toBe("thread.agent_working:Ada");

  const unnamed = renderRow({ session: session("u", "running", { execution: { phase: "running" } as never }), runningAgent: "claude" }, "run");
  expect(unnamed.querySelector(".conversation-status")?.textContent).toBe("thread.group_running");
});

it.each(["completed", "cancelled", "failed"])("gives a settled standalone %s conversation its own badge", (status) => {
  const container = renderRow({ session: session("chat", status, { execution: { phase: "terminal" } as never }) }, "idle");
  expect(container.querySelector(".task-status-icon")).toBeNull();
  expect(container.querySelector(".thread-status-badge")?.getAttribute("data-state")).toBe(status === "completed" ? "ready" : status);
  expect(container.querySelector(".conversation-status")).toBeNull();
  expect(container.querySelector(".conversation-subline")).toBeNull();
  expect(screen.getByRole("button", { name: /Thread chat/ }).getAttribute("aria-label")).not.toContain("thread.group_idle");
});

it("keeps a conversation badge distinct from task status in nested project rows", () => {
  const container = renderRow({ session: session("project-chat", "cancelled", { projectId: "project" }), projectName: "Website" }, "idle", "nested");
  expect(container.querySelector(".task-status-icon")).toBeNull();
  expect(container.querySelector(".thread-status-badge")?.getAttribute("data-state")).toBe("cancelled");
  expect(screen.getByRole("button", { name: /Thread project-chat/ }).getAttribute("aria-label")).not.toContain("thread.group_idle");
});

it.each(["backlog", "assigned", "queued", "running", "waiting_for_human", "review", "done", "blocked", "cancelled"] as const)(
  "uses the linked task's %s status even after the thread completes",
  (status) => {
    for (const layout of ["full", "nested"] as const) {
      const container = renderRow({
        session: session(`task-${status}-${layout}`, "completed"),
        origin: { kind: "backlog", taskId: "task", ref: "#1", title: "Task", status },
      }, "idle", layout);
      expect(container.querySelector(".task-status-icon")?.getAttribute("data-status")).toBe(status);
      expect(container.querySelector(".state-mark")).toBeNull();
      expect(container.querySelector(".conversation-row-inner")?.getAttribute("aria-label")).toContain(`backlog.statuses.${status}`);
    }
  },
);
