import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DossierNameField } from "../src/components/workspace/DossierNameField";

const base = { label: "Project name", name: "API revamp", inputName: "project-name", renameLabel: "Rename project", saveLabel: "Save project" };

it("renames in place and closes once the save lands", async () => {
  const onSave = vi.fn().mockResolvedValue(true);
  render(<DossierNameField {...base} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename project" }));
  const input = screen.getByRole("textbox", { name: "Project name" });
  fireEvent.change(input, { target: { value: "  Billing  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(onSave).toHaveBeenCalledWith("Billing"));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
});

it("keeps the editor open with the error when the save fails", async () => {
  const onSave = vi.fn().mockResolvedValue(false);
  const { rerender } = render(<DossierNameField {...base} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename project" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Billing" } });
  fireEvent.click(screen.getByRole("button", { name: "Save project" }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  rerender(<DossierNameField {...base} onSave={onSave} error="The project changed again." />);
  expect(screen.getByRole("textbox")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("The project changed again.");
});

it("skips the save for an unchanged or blank name, and Escape cancels", async () => {
  const onSave = vi.fn();
  render(<DossierNameField {...base} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename project" }));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("textbox")).toBeTruthy();
  fireEvent.change(input, { target: { value: " API revamp " } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Rename project" }));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(onSave).not.toHaveBeenCalled();
});

it("hides the pencil on a read-only record", () => {
  render(<DossierNameField {...base} readOnly onSave={vi.fn()} />);
  expect(screen.getByText("API revamp")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Rename project" })).toBeNull();
});
