import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ThreadRow } from "../src/components/ThreadRow";
import type { RelaySession } from "../src/types";
import type { ThreadItem } from "../src/lib/threads";

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

/* The rail no longer filters by state, so every row has to answer "what is
   this thread doing?" on its own — including a settled one, which says
   nothing in words. */
it("marks every row's state, whatever the row has to say", () => {
  for (const [status, shape, tone] of [
    ["waiting_for_human", "solid", "warn"],
    ["running", "live", "live"],
    ["completed", "muted", "neutral"],
  ] as const) {
    const container = renderRow(
      { session: session(status, status) },
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

it("rings a failed thread even though it files under Idle", () => {
  // A failed thread is not running and needs no decision, so the rail groups
  // it with the settled ones. The group tone drew it with the same grey muted
  // pip as a clean finish, leaving the word "Failed" as the only difference.
  const failed = renderRow({ session: session("f", "failed") }, "idle").querySelector(".state-mark");
  expect(failed?.getAttribute("data-shape")).toBe("ring");
  expect(failed?.getAttribute("data-tone")).toBe("bad");

  // A cancel was the user's own call, not a fault: it keeps the settled pip.
  const cancelled = renderRow({ session: session("c", "cancelled") }, "idle").querySelector(".state-mark");
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
