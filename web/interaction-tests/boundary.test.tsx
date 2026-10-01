import { fireEvent, render, screen } from "@testing-library/react";
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

it("reports the failure with its component stack instead of swallowing it", async () => {
  const { ScreenErrorBoundary } = await import("../src/components/ScreenErrorBoundary");
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never { throw new Error("render exploded"); }
  render(<ScreenErrorBoundary resetKey="a"><Broken /></ScreenErrorBoundary>);
  expect(report).toHaveBeenCalledWith(
    "[relay] screen failed to render",
    expect.objectContaining({ message: "render exploded" }),
    expect.objectContaining({ componentStack: expect.any(String) }),
  );
});

it("retries the same screen in place before falling back to a full reload", async () => {
  const { ScreenErrorBoundary } = await import("../src/components/ScreenErrorBoundary");
  vi.spyOn(console, "error").mockImplementation(() => {});
  let shouldThrow = true;
  function Flaky() {
    if (shouldThrow) throw new Error("transient");
    return <p>Recovered screen</p>;
  }
  render(<ScreenErrorBoundary resetKey="a"><Flaky /></ScreenErrorBoundary>);
  expect(screen.getByRole("alert")).toBeTruthy();

  shouldThrow = false;
  fireEvent.click(screen.getByRole("button", { name: "errors.try_again" }));

  expect(screen.getByText("Recovered screen")).toBeTruthy();
});
