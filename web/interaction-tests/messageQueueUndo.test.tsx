import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../src/components/composer/MessageQueue";

const props = { running: false, onSteer: vi.fn(), onEdit: vi.fn(), onRemove: vi.fn(), onUndo: vi.fn() };

describe("queue removal notice", () => {
  afterEach(() => vi.useRealTimers());

  it("offers undo for five seconds, then hides an empty queue", () => {
    vi.useFakeTimers();
    const removedAt = new Date().toISOString();
    render(<MessageQueue {...props} messages={[]} removedAt={removedAt} />);
    expect(screen.getByRole("button", { name: /undo|撤销/i })).toBeTruthy();
    act(() => vi.advanceTimersByTime(4999));
    expect(screen.getByRole("button", { name: /undo|撤销/i })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("keeps remaining messages and errors visible after the notice expires", () => {
    vi.useFakeTimers();
    render(<MessageQueue {...props} messages={[{ id: "next", text: "Next" }]} error="Error" removedAt={new Date().toISOString()} />);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByText("Next")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Error");
    expect(screen.queryByRole("button", { name: /undo|撤销/i })).toBeNull();
  });

  it("allows undo and starts a fresh window for a later removal", () => {
    vi.useFakeTimers();
    const onUndo = vi.fn();
    const { rerender } = render(<MessageQueue {...props} onUndo={onUndo} messages={[]} removedAt={new Date().toISOString()} />);
    fireEvent.click(screen.getByRole("button", { name: /undo|撤销/i }));
    expect(onUndo).toHaveBeenCalledOnce();
    rerender(<MessageQueue {...props} messages={[{ id: "restored", text: "Restored" }]} />);
    act(() => vi.advanceTimersByTime(5000));
    rerender(<MessageQueue {...props} messages={[]} removedAt={new Date().toISOString()} />);
    expect(screen.getByRole("button", { name: /undo|撤销/i })).toBeTruthy();
  });

  it("does not reopen an expired notice on mount", () => {
    vi.useFakeTimers();
    render(<MessageQueue {...props} messages={[]} removedAt={new Date(Date.now() - 5000).toISOString()} />);
    act(() => vi.advanceTimersByTime(0));
    expect(screen.queryByRole("region")).toBeNull();
  });
});
