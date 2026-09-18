import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ExecutionRecoveryPanel, TaskRecoveryPanel } from "../src/components/ExecutionRecoveryPanel";
import { executionRecoveryGuide, taskRecoveryGuide } from "../src/lib/executionRecovery";
import type { RelaySession, RelayTaskListItem } from "../src/types";

const execution = (reason: string, phase = "recovery_required") => ({ phase, blockingReason: reason, canDelete: false, executionConfirmed: false, deletionRequested: false, lastConfirmedAt: null, nextRecoveryAt: null }) as NonNullable<RelaySession["execution"]>;
const session = (reason: string) => ({ id: "thread-1", computerId: "computer-1", execution: execution(reason) }) as RelaySession;
const task = (code?: string, status = "blocked") => ({ id: "task-1", status, blockerReason: "Original failure", linkedSessionIds: ["thread-1"], dispatchOutcome: code ? { state: "rejected", code } : undefined }) as RelayTaskListItem;

it.each(["finalization_failed", "termination_unconfirmed", "orphaned_run", "execution_unconfirmed", "awaiting_dispatch", "awaiting_termination", "saving_results"])("explains execution blocker %s", reason => {
  expect(executionRecoveryGuide(execution(reason))?.key).toBe(reason);
  render(<ExecutionRecoveryPanel session={session(reason)} />);
  expect(screen.getByText(`recovery.${reason}.body`)).toBeTruthy();
});
it("does not interrupt healthy running or terminal threads, and explains unknown blockers", () => {
  expect(executionRecoveryGuide(execution("execution_active", "running"))).toBeNull();
  expect(executionRecoveryGuide(execution("", "terminal"))).toBeNull();
  expect(executionRecoveryGuide(undefined)).toBeNull();
  expect(executionRecoveryGuide(execution("future_reason"))?.key).toBe("unknown");
});
it("only retries finalization, prevents duplicate requests and reports failure", async () => {
  let reject!: (error: Error) => void;
  const retry = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
  const view = render(<ExecutionRecoveryPanel session={session("finalization_failed")} onRetry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: "recovery.retry" }));
  expect((screen.getByRole("button", { name: "recovery.retrying" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("alert").textContent).toContain("recovery.action_failed");
  view.rerender(<ExecutionRecoveryPanel session={session("termination_unconfirmed")} onRetry={retry} />);
  expect(screen.queryByRole("button", { name: "recovery.retry" })).toBeNull();
  expect(screen.getByRole("link", { name: "recovery.computer" }).getAttribute("href")).toBe("/computer");
});
it("confirms a requested retry without claiming recovery completed", async () => {
  render(<ExecutionRecoveryPanel session={session("finalization_failed")} onRetry={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.click(screen.getByRole("button", { name: "recovery.retry" }));
  await waitFor(() => expect(screen.getByText("recovery.retry_requested")).toBeTruthy());
});
it.each([
  ["agent_disabled", "assignment"], ["team_not_found", "assignment"], ["project_roster_invalid", "assignment"],
  ["agent_forbidden", "access"], ["project_forbidden", "access"],
  ["agent_offline", "offline"], ["configuration_pending", "provisioning"],
  ["workspace_unavailable", "workspace"], ["capacity_exhausted", "capacity"],
  ["task_wip_limit", "wip"], ["task_execution_active", "ownership"],
  ["dispatch_in_progress", "ownership"], ["dispatch_retry_exhausted", "retry_exhausted"],
  ["dispatch_failed", "failure"], ["new_error", "failure"],
])("gives actionable guidance for %s", (code, key) => {
  expect(taskRecoveryGuide(task(code))?.key).toBe(key);
});
it("does not use old dispatch errors to diagnose human waits or completed work", () => {
  expect(taskRecoveryGuide(task("agent_offline", "waiting_for_human"))?.key).toBe("human");
  expect(taskRecoveryGuide(task("agent_offline", "review"))?.key).toBe("review");
  expect(taskRecoveryGuide(task("agent_offline", "done"))).toBeNull();
  expect(taskRecoveryGuide(task(undefined))?.key).toBe("failure");
});
it("preserves the actual task reason, links the transcript, and explains unblocking", () => {
  render(<TaskRecoveryPanel task={task("dispatch_retry_exhausted")} />);
  expect(screen.getByText("Original failure")).toBeTruthy();
  expect(screen.getByText("recovery.unblock_help")).toBeTruthy();
  expect(screen.getByRole("link", { name: "recovery.thread" }).getAttribute("href")).toBe("/threads/thread-1");
});
