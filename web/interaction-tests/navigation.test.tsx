import { it, expect, vi } from "vitest";
import { navigateToAppPath } from "../src/lib/appRoute";

it("keeps the current URL until a dirty form permits navigation", async () => {
  const { registerNavigationGuard } = await import("../src/lib/navigationGuard");
  window.history.replaceState({}, "", "/agents/one");
  const guard = vi.fn().mockResolvedValue(false);
  const release = registerNavigationGuard(guard);
  await navigateToAppPath("/backlog");
  expect(window.location.pathname).toBe("/agents/one");
  guard.mockResolvedValue(true);
  await navigateToAppPath("/backlog");
  expect(window.location.pathname).toBe("/backlog");
  release();
});

it("restores Back on cancel and replays Back/Forward after confirmation", async () => {
  const { registerNavigationGuard, installNavigationHistory } = await import("../src/lib/navigationGuard");
  const { waitFor } = await import("@testing-library/react");
  window.history.replaceState({}, "", "/threads");
  const dispose = installNavigationHistory();
  await navigateToAppPath("/agents/one");
  const guard = vi.fn().mockResolvedValue(false);
  const release = registerNavigationGuard(guard);
  window.history.back();
  await waitFor(() => expect(guard).toHaveBeenCalledTimes(1));
  expect(window.location.pathname).toBe("/agents/one");
  guard.mockResolvedValue(true);
  window.history.back();
  await waitFor(() => expect(window.location.pathname).toBe("/threads"));
  window.history.forward();
  await waitFor(() => expect(window.location.pathname).toBe("/agents/one"));
  release(); dispose();
});

it("does not commit a tab switch when an active form cancels", async () => {
  const { registerNavigationGuard } = await import("../src/lib/navigationGuard");
  const { renderHook, act } = await import("@testing-library/react");
  const { useUrlSearchState } = await import("../src/hooks/useUrlSearchState");
  window.history.replaceState({}, "", "/agents/one");
  const release = registerNavigationGuard(async () => false);
  const { result, unmount } = renderHook(() => useUrlSearchState("tab", "profile", value => value ?? "profile", value => value, "push"));
  await act(async () => result.current[1]("activities"));
  expect(result.current[0]).toBe("profile");
  expect(window.location.search).toBe("");
  unmount(); release();
});

it("preserves a mobile view change when the canonical pathname stays the same", async () => {
  const { renderHook, act } = await import("@testing-library/react");
  const { useAppRouter } = await import("../src/hooks/useAppRouter");
  window.history.replaceState({}, "", "/threads");
  const options = { composingNew: false, activeSessionId: null, selectedSessionId: undefined, activeSession: undefined, onApplySessionFromPath: vi.fn(), onSetComposingNewFromPath: vi.fn(), onClearPendingMessage: vi.fn() };
  const { result, unmount } = renderHook(() => useAppRouter(options));
  act(() => result.current.navigateToMobileView("chat"));
  expect(result.current.mobileView).toBe("chat");
  expect(window.location.pathname).toBe("/threads");
  unmount();
});
