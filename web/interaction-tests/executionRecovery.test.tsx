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
it("shows pending deletion and resets feedback on thread changes", async () => {
  const first = session("finalization_failed");
  first.execution!.deletionRequested = true;
  const retry = vi.fn().mockRejectedValue(new Error("offline"));
  const view = render(<ExecutionRecoveryPanel session={first} onRetry={retry} />);
  expect(screen.getByText("recovery.deletion_pending")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "recovery.retry" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  view.rerender(<ExecutionRecoveryPanel session={{ ...session("finalization_failed"), id: "thread-2" }} onRetry={retry} />);
  expect(screen.queryByRole("alert")).toBeNull();
});
it("preserves modified link clicks and opens the actual blocking thread", () => {
  const open = vi.fn();
  const blocked = { ...task("task_execution_active"), workspaceWaiting: { runId: "run", sessionId: "thread-1", blockingSessionId: "blocking-thread" } };
  render(<TaskRecoveryPanel task={blocked} onOpenThread={open} />);
  const link = screen.getByRole("link", { name: "recovery.thread" });
  expect(link.getAttribute("href")).toBe("/threads/blocking-thread");
  link.addEventListener("click", event => event.preventDefault(), { once: true });
  fireEvent.click(link, { ctrlKey: true });
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(link);
  expect(open).toHaveBeenCalledWith("blocking-thread");
});
it("omits resolved task notices and explains workspace contention without dispatch errors", () => {
  expect(taskRecoveryGuide(task(undefined, "backlog"))).toBeNull();
  expect(taskRecoveryGuide({ ...task(undefined, "assigned"), dispatchOutcome: { state: "started" } })).toBeNull();
  expect(taskRecoveryGuide({ ...task(undefined, "assigned"), workspaceWaiting: { runId: "r", sessionId: "s" } })?.key).toBe("ownership");
  const view = render(<TaskRecoveryPanel task={task(undefined, "running")} />);
  expect(view.container.textContent).toBe("");
  view.rerender(<ExecutionRecoveryPanel session={{ ...session(""), execution: undefined }} />);
  expect(view.container.textContent).toBe("");
});
it("honors the unsaved-change guard when opening computer recovery", async () => {
  const { registerNavigationGuard } = await import("../src/lib/navigationGuard");
  const guard = vi.fn().mockResolvedValue(false);
  const unregister = registerNavigationGuard(guard);
  render(<ExecutionRecoveryPanel session={session("execution_unconfirmed")} />);
  fireEvent.click(screen.getByRole("link", { name: "recovery.computer" }));
  await waitFor(() => expect(guard).toHaveBeenCalledOnce());
  unregister();
});
it("supports legacy or missing computer identity and absent thread links", () => {
  const legacy = { ...session("orphaned_run"), computerId: undefined, managedNodeId: "managed", daemonNodeId: "daemon" };
  const view = render(<ExecutionRecoveryPanel session={legacy} />);
  expect(screen.getByText("recovery.host")).toBeTruthy();
  view.rerender(<ExecutionRecoveryPanel session={{ ...legacy, managedNodeId: undefined }} />);
  expect(screen.getByText("recovery.host")).toBeTruthy();
  view.rerender(<ExecutionRecoveryPanel session={{ ...legacy, managedNodeId: undefined, daemonNodeId: undefined }} />);
  expect(screen.queryByText("recovery.host")).toBeNull();
  view.rerender(<TaskRecoveryPanel task={{ ...task("agent_offline", "assigned"), linkedSessionIds: [], dispatchOutcome: { state: "queued", code: "agent_offline", message: "Offline computer" } }} />);
  expect(screen.getByText("Offline computer")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "recovery.thread" })).toBeNull();
  expect(executionRecoveryGuide({ ...execution(""), blockingReason: null })?.key).toBe("unknown");
});
it("ignores dispatch errors from a previously started run and safely handles unknown codes", () => {
  expect(taskRecoveryGuide({ ...task("agent_offline"), dispatchOutcome: { state: "started", code: "agent_offline" } })?.key).toBe("failure");
  expect(taskRecoveryGuide(task("constructor"))?.key).toBe("failure");
  expect(executionRecoveryGuide(execution("constructor"))?.key).toBe("unknown");
});
it("explains workspace contention even after a task enters In progress", () => {
  expect(taskRecoveryGuide({ ...task(undefined, "running"), workspaceWaiting: { runId: "r", sessionId: "s", blockingSessionId: "other" } })?.key).toBe("ownership");
});
it("draws every wayfinding action as a shared link-button, not a bare anchor", () => {
  render(<TaskRecoveryPanel task={task("agent_offline")} onOpenThread={vi.fn()} />);
  for (const name of ["recovery.computer", "recovery.thread"]) {
    const link = screen.getByRole("link", { name });
    expect(link.getAttribute("data-slot")).toBe("link-button");
    expect(link.className).toContain("btn-ghost");
  }
});
it("keeps the panel navigable when the surface has no in-app thread handler", () => {
  const view = render(<TaskRecoveryPanel task={task("dispatch_retry_exhausted")} />);
  const link = screen.getByRole("link", { name: "recovery.thread" });
  // Listen above React's root so the check sees the handler's decision, and
  // stop jsdom from attempting the real navigation afterwards.
  let prevented = true;
  document.addEventListener("click", event => { prevented = event.defaultPrevented; event.preventDefault(); }, { once: true });
  fireEvent.click(link);
  expect(prevented).toBe(false);
  view.unmount();
});
it("warns only about faults — work waiting on a person reads as information", () => {
  const view = render(<TaskRecoveryPanel task={task(undefined, "review")} />);
  const tone = () => view.container.querySelector(".recovery-panel")?.getAttribute("data-tone");
  expect(tone()).toBe("info");
  view.rerender(<TaskRecoveryPanel task={task(undefined, "waiting_for_human")} />);
  expect(tone()).toBe("info");
  view.rerender(<TaskRecoveryPanel task={task("agent_offline")} />);
  expect(tone()).toBe("attention");
});
it("announces a requested retry through a live region that predates the request", async () => {
  const view = render(<ExecutionRecoveryPanel session={session("finalization_failed")} onRetry={vi.fn().mockResolvedValue(undefined)} />);
  const region = view.container.querySelector("[role='status']");
  expect(region?.textContent).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "recovery.retry" }));
  await waitFor(() => expect(region?.textContent).toBe("recovery.retry_requested"));
});
it("lets one drawer surface a thread once, without hiding a different blocker", () => {
  const view = render(<TaskRecoveryPanel task={task("dispatch_retry_exhausted")} excludeSessionId="thread-1" />);
  expect(screen.queryByRole("link", { name: "recovery.thread" })).toBeNull();
  const blocked = { ...task("task_execution_active"), workspaceWaiting: { runId: "run", sessionId: "thread-1", blockingSessionId: "blocking-thread" } };
  view.rerender(<TaskRecoveryPanel task={blocked} excludeSessionId="thread-1" />);
  expect(screen.getByRole("link", { name: "recovery.thread" }).getAttribute("href")).toBe("/threads/blocking-thread");
});
