import { fireEvent, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useGlobalShortcuts } from "../src/hooks/useGlobalShortcuts";

it("uses current handlers and overlay state without renewing the document subscription", () => {
  const first = vi.fn();
  const second = vi.fn();
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  const { rerender, unmount } = renderHook((props) => useGlobalShortcuts(props), { initialProps: { isAdmin: false, overlayOpen: false, onAction: first } });
  fireEvent.keyDown(document, { key: "c" });
  expect(first).toHaveBeenLastCalledWith({ kind: "new-task" });
  rerender({ isAdmin: false, overlayOpen: true, onAction: second });
  fireEvent.keyDown(document, { key: "c" });
  expect(second).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "k", ctrlKey: true });
  expect(second).toHaveBeenLastCalledWith({ kind: "command-menu" });
  rerender({ isAdmin: true, overlayOpen: false, onAction: second });
  fireEvent.keyDown(document, { key: "g" });
  fireEvent.keyDown(document, { key: "d" });
  expect(second).toHaveBeenLastCalledWith({ kind: "go", route: "admin" });
  const registrations = add.mock.calls.filter(([event]) => event === "keydown");
  expect(registrations).toHaveLength(1);
  unmount();
  expect(remove).toHaveBeenCalledWith("keydown", registrations[0][1]);
});

it("lets an open dialog own keyboard actions", () => {
  const onAction = vi.fn();
  renderHook(() => useGlobalShortcuts({ isAdmin: false, overlayOpen: false, onAction }));
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  fireEvent.keyDown(document, { key: "n" });
  expect(onAction).not.toHaveBeenCalled();
  modal.remove();
  fireEvent.keyDown(document, { key: "x" });
  expect(onAction).not.toHaveBeenCalled();
});
