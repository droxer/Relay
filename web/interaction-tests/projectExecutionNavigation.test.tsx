import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ThreadMeta } from "../src/components/ThreadMeta";
import { ThreadHeader } from "../src/components/ThreadHeader";
import { useAppRouter } from "../src/hooks/useAppRouter";
import type { RelaySession } from "../src/types";

vi.mock("../src/hooks/useProjectLookup", () => ({ useProjectLookup: () => (id: string) => ({ id, name: "Launch" }) }));

const session = { id: "execution", projectId: "project one", taskGoal: "Run project work" } as RelaySession;
const noop = () => {};

function Execution({ loading = false }: { loading?: boolean }) {
  const router = useAppRouter({
    composingNew: false, activeSessionId: session.id,
    selectedSessionId: session.id, activeSession: session,
    onApplySessionFromPath: noop, onSetComposingNewFromPath: noop,
    onClearPendingMessage: noop,
  });
  return <>
    <output>{router.projectId}:{router.routedSessionId ?? "overview"}</output>
    <ThreadHeader activeSession={loading ? undefined : session} facts={<ThreadMeta session={session} participants={[]} computers={[]} onOpenProject={router.navigateToProject} />} artifactCount={0} spaceOpen={false}
      threadListHidden={false} onToggleSpace={noop} onToggleThreadList={noop}
      onBackToThreads={() => router.navigateToMobileView("threads")} />
  </>;
}

it("returns from execution details to the named project, including a direct link", async () => {
  window.history.replaceState({}, "", "/projects/project%20one/threads/execution");
  render(<Execution />);
  const back = screen.getByRole("link", { name: "thread.band_project: Launch" });
  expect(back.getAttribute("href")).toBe("/projects/project%20one");
  expect(back.classList.contains("mobile-back-button")).toBe(false);
  fireEvent.click(back);
  await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/projects/project%20one"));
  expect(screen.getByText("project one:overview")).toBeTruthy();
  window.history.back();
  await waitFor(() => expect(screen.getByText("project one:execution")).toBeTruthy());
  window.history.forward();
  await waitFor(() => expect(screen.getByText("project one:overview")).toBeTruthy());
});

it("keeps the threads control for standalone executions", () => {
  const onBack = vi.fn();
  render(<ThreadHeader activeSession={{ ...session, projectId: undefined }} artifactCount={0}
    spaceOpen={false} threadListHidden={false} onToggleSpace={noop}
    onToggleThreadList={noop} onBackToThreads={onBack} />);
  expect(screen.queryByRole("link", { name: "thread.band_project: Launch" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "nav.threads" }));
  expect(onBack).toHaveBeenCalledOnce();
});

it("offers a return path before the execution has loaded", async () => {
  window.history.replaceState({}, "", "/projects/project%20one/threads/execution");
  render(<Execution loading />);
  fireEvent.click(screen.getByRole("link", { name: "thread.band_project: Launch" }));
  await waitFor(() => expect(window.location.pathname).toBe("/projects/project%20one"));
});

it("respects a navigation guard when opening the project", async () => {
  const { registerNavigationGuard } = await import("../src/lib/navigationGuard");
  window.history.replaceState({}, "", "/projects/project%20one/threads/execution");
  const guard = vi.fn().mockResolvedValue(false);
  const release = registerNavigationGuard(guard);
  try {
    render(<Execution />);
    fireEvent.click(screen.getByRole("link", { name: "thread.band_project: Launch" }));
    await waitFor(() => expect(guard).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe("/projects/project%20one/threads/execution");
  } finally {
    release();
  }
});
