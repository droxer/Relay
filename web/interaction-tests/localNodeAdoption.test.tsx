import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { useLocalNodeAdoption } from "../src/hooks/useLocalNodeAdoption";

it("adopts once while enabled, however often it re-renders", async () => {
  const adopt = vi.fn().mockResolvedValue(undefined);
  const { rerender } = renderHook(({ enabled }) => useLocalNodeAdoption(enabled, adopt), {
    initialProps: { enabled: true },
  });
  rerender({ enabled: true });

  await waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));
});

it("waits until it is enabled", () => {
  const adopt = vi.fn().mockResolvedValue(undefined);
  renderHook(() => useLocalNodeAdoption(false, adopt));

  expect(adopt).not.toHaveBeenCalled();
});

it("logs a failed adoption and retries when its inputs change", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = new Error("403");
  const first = vi.fn().mockRejectedValue(failure);
  const { rerender } = renderHook(({ adopt }) => useLocalNodeAdoption(true, adopt), {
    initialProps: { adopt: first },
  });
  await waitFor(() => expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("will retry"), failure));

  const second = vi.fn().mockResolvedValue(undefined);
  rerender({ adopt: second });

  await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
});

it("does not adopt again after a success, even when its inputs change", async () => {
  const first = vi.fn().mockResolvedValue(undefined);
  const { rerender } = renderHook(({ adopt }) => useLocalNodeAdoption(true, adopt), {
    initialProps: { adopt: first },
  });
  await waitFor(() => expect(first).toHaveBeenCalledTimes(1));

  const second = vi.fn().mockResolvedValue(undefined);
  rerender({ adopt: second });

  expect(second).not.toHaveBeenCalled();
});
