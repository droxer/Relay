import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BuildUpdateNotice } from "../src/components/BuildUpdateNotice";
import { toast } from "../src/components/ui/toast";
import { markBuildStale, resetBuildFreshness } from "../src/lib/buildFreshness";

// setup.tsx replaces the toast module with a spy.
const add = vi.mocked(toast.add);

afterEach(() => {
  resetBuildFreshness();
  add.mockClear();
});

it("stays quiet while the running build is current", () => {
  render(<BuildUpdateNotice />);
  expect(add).not.toHaveBeenCalled();
});

it("offers a reload that stays until taken once a newer build is deployed", async () => {
  const view = render(<BuildUpdateNotice />);
  await act(async () => { markBuildStale(); });
  view.rerender(<BuildUpdateNotice />);

  expect(add).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledWith(expect.objectContaining({
    title: "app_update.title",
    timeout: 0,
    actionProps: expect.objectContaining({ children: "app_update.reload" }),
  }));
});
