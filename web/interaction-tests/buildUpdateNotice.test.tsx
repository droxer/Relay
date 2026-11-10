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

it("reloads on a completed touch even when the browser sends no click", async () => {
  render(<BuildUpdateNotice />);
  await act(async () => { markBuildStale(); });
  const action = add.mock.calls[0][0].actionProps;
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });
  const touch = { identifier: 1, clientX: 100, clientY: 100 };
  const preventDefault = vi.fn();

  action?.onTouchStart?.({ touches: [touch] } as never);
  action?.onTouchEnd?.({ changedTouches: [touch], preventDefault } as never);

  expect(reload).toHaveBeenCalledTimes(1);
  expect(preventDefault).toHaveBeenCalledTimes(1);
});

it("does not reload after a touch moves into a swipe", async () => {
  render(<BuildUpdateNotice />);
  await act(async () => { markBuildStale(); });
  const action = add.mock.calls[0][0].actionProps;
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });
  const start = { identifier: 1, clientX: 100, clientY: 100 };
  const moved = { ...start, clientX: 130 };

  action?.onTouchStart?.({ touches: [start] } as never);
  action?.onTouchMove?.({ touches: [moved] } as never);
  action?.onTouchEnd?.({ changedTouches: [start], preventDefault: vi.fn() } as never);

  expect(reload).not.toHaveBeenCalled();
});

it("does not reload a cancelled touch", async () => {
  render(<BuildUpdateNotice />);
  await act(async () => { markBuildStale(); });
  const action = add.mock.calls[0][0].actionProps;
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });
  const touch = { identifier: 1, clientX: 100, clientY: 100 };

  action?.onTouchStart?.({ touches: [touch] } as never);
  action?.onTouchCancel?.({} as never);
  action?.onTouchEnd?.({ changedTouches: [touch], preventDefault: vi.fn() } as never);

  expect(reload).not.toHaveBeenCalled();
});

it("still reloads on keyboard or mouse activation", async () => {
  render(<BuildUpdateNotice />);
  await act(async () => { markBuildStale(); });
  const action = add.mock.calls[0][0].actionProps;
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { reload } });

  action?.onClick?.({} as never);

  expect(reload).toHaveBeenCalledTimes(1);
});
