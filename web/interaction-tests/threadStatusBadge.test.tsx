import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { ThreadStatusBadge } from "../src/components/ThreadStatusBadge";
import type { RelaySession } from "../src/types";

function session(extra: object): RelaySession {
  return { status: "completed", agentRuns: [], ...extra } as RelaySession;
}

it.each([
  [{}, "ready", "neutral"],
  [{ status: "failed" }, "failed", "danger"],
  [{ status: "cancelled" }, "cancelled", "neutral"],
  [{ workOutcome: "blocked" }, "waiting_for_human", "warning"],
  [{ status: "running", permissionRequests: [{}], execution: { phase: "running" } }, "waiting_for_human", "warning"],
  [{ status: "running", execution: { phase: "terminal" } }, "ready", "neutral"],
  [{ execution: { phase: "queued" } }, "queued", "neutral"],
  [{ execution: { phase: "running" } }, "running", "info"],
  [{ execution: { phase: "stopping" } }, "stopping", "warning"],
  [{ execution: { phase: "finalizing" } }, "finalizing", "info"],
  [{ execution: { phase: "unresponsive" } }, "unresponsive", "danger"],
  [{ execution: { phase: "recovery_required" } }, "recovery_required", "danger"],
] as const)("shows conversation activity for %j", (extra, state, variant) => {
  const { container } = render(<ThreadStatusBadge session={session(extra)} />);
  const badge = container.querySelector(".thread-status-badge")!;
  expect(badge.getAttribute("data-state")).toBe(state);
  expect(badge.getAttribute("data-variant")).toBe(variant);
  expect(badge.getAttribute("title")).toBe(badge.textContent);
  expect(badge.querySelector("svg")).toBeTruthy();
  expect(badge.querySelector(".task-status-icon")).toBeNull();
});
