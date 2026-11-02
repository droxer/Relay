import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import * as api from "../src/api";
import { AccountSection } from "../src/components/settings/AccountSection";
import type { CurrentUser } from "../src/types";

const user = { id: "a1", username: "ada", displayName: "Ada", role: "user" } as CurrentUser;

it("saves a trimmed display name and updates the signed-in user", async () => {
  const updated = { ...user, displayName: "Ada Lovelace" };
  const save = vi.spyOn(api, "updateAccountProfile").mockResolvedValue({ user: updated });
  const onUserChange = vi.fn();
  render(<AccountSection user={user} onUserChange={onUserChange} />);
  fireEvent.change(screen.getByLabelText("account.display_name"), { target: { value: " Ada Lovelace " } });
  fireEvent.click(screen.getByText("account.save_name"));
  await waitFor(() => expect(onUserChange).toHaveBeenCalledWith(updated));
  expect(save).toHaveBeenCalledWith({ displayName: "Ada Lovelace" });
  expect(screen.getByRole("status").textContent).toBe("account.name_saved");
});

it("validates confirmation, displays server errors, and clears secrets after success", async () => {
  const save = vi.spyOn(api, "changePassword").mockRejectedValueOnce(new Error("Current password is incorrect.")).mockResolvedValue({ ok: true });
  render(<AccountSection user={user} onUserChange={vi.fn()} />);
  const current = screen.getByLabelText("account.current_password");
  const password = screen.getByLabelText("account.new_password");
  const confirm = screen.getByLabelText("account.confirm_password");
  fireEvent.change(current, { target: { value: "old-passphrase-741" } });
  fireEvent.change(password, { target: { value: "otter-meadow-8294" } });
  fireEvent.change(confirm, { target: { value: "different" } });
  const button = screen.getByRole("button", { name: "account.change_password" });
  fireEvent.click(button);
  expect(screen.getByRole("alert").textContent).toBe("account.password_mismatch");
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(confirm, { target: { value: "otter-meadow-8294" } });
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Current password is incorrect."));
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("account.password_saved"));
  expect((current as HTMLInputElement).value).toBe("");
  expect((password as HTMLInputElement).value).toBe("");
  expect((confirm as HTMLInputElement).value).toBe("");
});
