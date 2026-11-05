import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ThreadRow } from "../src/components/ThreadRow";
import type { RelaySession } from "../src/types";
import type { ThreadItem } from "../src/lib/threads";

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

it("marks a task thread's state, including when it is settled", () => {
  for (const [status, shape, tone] of [
    ["waiting_for_human", "solid", "warn"],
    ["running", "live", "live"],
    ["completed", "muted", "neutral"],
  ] as const) {
    const container = renderRow(
      { session: session(status, status), origin: { kind: "backlog", taskId: "task", title: "Task" } },
      status === "waiting_for_human" ? "attn" : status === "running" ? "run" : "idle",
    );
    const marks = container.querySelectorAll(".state-mark");
    expect(marks.length).toBe(1);
    expect(marks[0].getAttribute("data-shape")).toBe(shape);
    expect(marks[0].getAttribute("data-tone")).toBe(tone);
    // It leads the title, the same place a nested row has always carried it,
    // so the marks line up in one scannable column down the rail.
    expect(container.querySelector(".conversation-topline")?.firstElementChild).toBe(marks[0]);
    screen.getByText(`Thread ${status}`);
  }
});

it("spends the ring on a thread whose computer gave out, not on a settled one", () => {
  const container = renderRow(
    { session: session("x", "running", { execution: { phase: "unresponsive" } as never }) },
    "run",
  );
  const mark = container.querySelector(".state-mark");
  expect(mark?.getAttribute("data-shape")).toBe("ring");
  expect(mark?.getAttribute("data-tone")).toBe("bad");
});

it("keeps failure and cancellation status for task threads", () => {
  // A failed thread is not running and needs no decision, so the rail groups
  // it with the settled ones. The group tone drew it with the same grey muted
  // pip as a clean finish, leaving the word "Failed" as the only difference.
  const failed = renderRow({ session: session("f", "failed"), origin: { kind: "backlog", taskId: "task", title: "Task" } }, "idle").querySelector(".state-mark");
  expect(failed?.getAttribute("data-shape")).toBe("ring");
  expect(failed?.getAttribute("data-tone")).toBe("bad");

  // A cancel was the user's own call, not a fault: it keeps the settled pip.
  const cancelled = renderRow({ session: session("c", "cancelled"), origin: { kind: "routine", taskId: "auto", title: "Automation" } }, "idle").querySelector(".state-mark");
  expect(cancelled?.getAttribute("data-shape")).toBe("muted");
  expect(cancelled?.getAttribute("data-tone")).toBe("neutral");
});

it("never draws the state twice on one row", () => {
  // A running row still names its agent in words; the pip above is the only
  // place the tone is drawn.
  const container = renderRow(
    { session: session("r", "running"), runningAgent: "claude" } as ThreadItem,
    "run",
  );
  expect(container.querySelectorAll(".state-mark").length).toBe(1);
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

it.each(["completed", "cancelled", "failed"])("shows a settled standalone %s thread as a chat without lifecycle status", (status) => {
  const container = renderRow({ session: session("chat", status, { execution: { phase: "terminal" } as never }) }, "idle");
  expect(container.querySelector(".state-mark")).toBeNull();
  expect(container.querySelector(".conversation-status")).toBeNull();
  expect(container.querySelector(".conversation-subline")).toBeNull();
  expect(screen.getByRole("button", { name: /Thread chat/ }).getAttribute("aria-label")).not.toContain("thread.group_idle");
});

it("keeps project context without giving a standalone project chat a status", () => {
  const container = renderRow({ session: session("project-chat", "cancelled", { projectId: "project" }), projectName: "Website" }, "idle", "nested");
  expect(container.querySelector(".state-mark")).toBeNull();
  expect(screen.getByRole("button", { name: /Thread project-chat/ }).getAttribute("aria-label")).not.toContain("thread.group_idle");
});
