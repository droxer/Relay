import { act, render, renderHook, screen } from "@testing-library/react";
import { startTransition, Suspense, useState } from "react";
import { expect, it, vi } from "vitest";
import { useStableValue } from "../src/hooks/useStableValue";
import { useStableCallback } from "../src/hooks/useStableCallback";

it("keeps a value's identity until its signature changes", () => {
  const first = { id: "one" };
  const { result, rerender } = renderHook(({ value, signature }) => useStableValue(value, signature), {
    initialProps: { value: first, signature: "one" },
  });
  rerender({ value: { id: "one" }, signature: "one" });
  expect(result.current).toBe(first);
  const second = { id: "two" };
  rerender({ value: second, signature: "two" });
  expect(result.current).toBe(second);
});

it("does not lose the committed value when a transition is abandoned", async () => {
  const first = { id: "one" };
  const seen: typeof first[] = [];
  let change!: (id: string) => void;
  const pending = new Promise<never>(() => {});
  function Child({ id }: { id: string }) {
    const value = useStableValue({ id }, id);
    if (id === "two") throw pending;
    seen.push(value);
    return <p>{id}</p>;
  }
  function Harness() {
    const [state, setState] = useState({ id: "one" });
    change = (id) => setState({ id });
    return <Suspense fallback="Loading"><Child id={state.id} /></Suspense>;
  }
  render(<Harness />);
  await act(async () => { startTransition(() => change("two")); });
  await act(async () => { change("one"); });
  expect(screen.getByText("one")).toBeTruthy();
  expect(seen.at(-1)).toBe(seen[0]);
});

it("keeps event handlers stable and calls the latest committed callback", () => {
  const first = vi.fn();
  const second = vi.fn();
  const { result, rerender } = renderHook(({ callback }) => useStableCallback(callback), { initialProps: { callback: first } });
  const stable = result.current;
  rerender({ callback: second });
  expect(result.current).toBe(stable);
  act(() => result.current());
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
});
