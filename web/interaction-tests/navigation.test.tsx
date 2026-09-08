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
