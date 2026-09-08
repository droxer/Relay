import { render, screen } from "@testing-library/react";
import { it, expect, vi } from "vitest";
it("keeps navigation available when a screen throws and resets for a new route", async () => {
  const { ScreenErrorBoundary } = await import("../src/components/ScreenErrorBoundary");
  vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never { throw new Error("chunk failed"); }
  const view = render(<><nav>Navigation</nav><ScreenErrorBoundary resetKey="a"><Broken /></ScreenErrorBoundary></>);
  expect(screen.getByText("Navigation")).toBeTruthy();
  expect(screen.getByRole("alert")).toBeTruthy();
  view.rerender(<><nav>Navigation</nav><ScreenErrorBoundary resetKey="b"><p>Working screen</p></ScreenErrorBoundary></>);
  expect(screen.getByText("Working screen")).toBeTruthy();
});
