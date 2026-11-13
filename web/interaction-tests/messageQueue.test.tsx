import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MessageQueue } from "../src/components/composer/MessageQueue";

it("expands a message without changing the queue and moves it only on explicit edit", () => {
  const onEdit = vi.fn();
  render(<MessageQueue messages={[{ id: "q1", text: "Read this long instruction", addressAgentIds: ["a"] }]} running
    recipientNames={{ a: "Reviewer" }} onSteer={vi.fn()} onEdit={onEdit} onRemove={vi.fn()} />);
  const preview = screen.getByRole("button", { name: /Read this long instruction/ });
  fireEvent.click(preview);
  expect(preview.getAttribute("aria-expanded")).toBe("true");
  expect(onEdit).not.toHaveBeenCalled();
  expect(screen.getByText("Reviewer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "queue.edit_item" }));
  expect(onEdit).toHaveBeenCalledWith("q1");
});

it("offers undo even when the last queued message was removed", () => {
  const undo = vi.fn();
  render(<MessageQueue messages={[]} running={false} undoAvailable onUndo={undo}
    onSteer={vi.fn()} onEdit={vi.fn()} onRemove={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "queue.undo" }));
  expect(undo).toHaveBeenCalledOnce();
});

it("keeps all row actions keyboard reachable and exposes pause, sending and error states", () => {
  const steer = vi.fn(); const remove = vi.fn(); const resume = vi.fn();
  const props = { messages: [{ id: "q", text: "First" }, { id: "q2", text: "Second", addressTeamId: "missing" }],
    running: false, paused: true, error: "Localized failure", onResume: resume, onSteer: steer, onEdit: vi.fn(), onRemove: remove };
  const view = render(<MessageQueue {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "queue.resume" }));
  expect(resume).toHaveBeenCalledOnce();
  fireEvent.click(screen.getAllByRole("button", { name: "queue.send_item" })[0]);
  expect(steer).toHaveBeenCalledWith("q");
  fireEvent.click(screen.getAllByRole("button", { name: "queue.remove_item" })[0]);
  expect(remove).toHaveBeenCalledWith("q");
  const preview = screen.getByRole("button", { name: /First/ });
  fireEvent.click(preview); fireEvent.click(preview);
  expect(preview.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("alert").textContent).toBe("Localized failure");
  expect(screen.getByText("queue.recipient_unavailable")).toBeTruthy();
  view.rerender(<MessageQueue {...props} paused={false} waiting sending="q" />);
  expect(screen.getByRole("status").textContent).toBe("queue.sending");
  view.rerender(<MessageQueue {...props} paused={false} waiting />);
  expect(screen.getByRole("status").textContent).toBe("queue.waiting");
  view.rerender(<MessageQueue {...props} messages={[]} error={null} />);
  expect(screen.queryByRole("region")).toBeNull();
});
