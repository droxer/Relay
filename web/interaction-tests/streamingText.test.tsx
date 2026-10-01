import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useDebouncedStreamingAnnouncement, useSmoothStreamingText } from "../src/hooks/useSmoothStreamingText";

it("reveals the latest appended target and cancels frame work on unmount", () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const { result, rerender, unmount } = renderHook(({ text }) => useSmoothStreamingText(text, true), { initialProps: { text: "hello" } });
  expect(result.current).toBe("");
  rerender({ text: "hello world" });
  act(() => vi.advanceTimersByTime(2_000));
  expect(result.current).toBe("hello world");
  rerender({ text: "hello world more" });
  unmount();
  expect(cancel).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("settles corrected and completed output immediately", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const { result, rerender } = renderHook(({ text, streaming }) => useSmoothStreamingText(text, streaming), { initialProps: { text: "Original", streaming: false } });
  expect(result.current).toBe("Original");
  rerender({ text: "Corrected", streaming: true });
  expect(result.current).toBe("Corrected");
  rerender({ text: "Corrected and complete", streaming: false });
  expect(result.current).toBe("Corrected and complete");
});

it("clears an old announcement when a new stream starts", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ text, streaming }) => useDebouncedStreamingAnnouncement(text, streaming), { initialProps: { text: "First", streaming: true } });
  act(() => vi.advanceTimersByTime(600));
  expect(result.current).toBe("First");
  rerender({ text: "First", streaming: false });
  rerender({ text: "Second", streaming: true });
  expect(result.current).toBe("");
  act(() => vi.advanceTimersByTime(600));
  expect(result.current).toBe("Second");
});
