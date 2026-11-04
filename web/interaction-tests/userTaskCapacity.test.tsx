import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { EditUserDrawer } from "../src/components/admin/EditUserDrawer";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import { updateControlPanelUser } from "../src/api";

vi.mock("../src/api", () => ({ updateControlPanelUser: vi.fn() }));
vi.mock("../src/components/admin/UserPasswordReset", () => ({ UserPasswordReset: () => null }));

it("defaults a user's task capacity to five and saves an edited limit", async () => {
  const onSuccess = vi.fn();
  vi.mocked(updateControlPanelUser).mockResolvedValue({ user: { id: "alice", displayName: "Alice", maxConcurrentTasks: 2 } });
  render(<DialogProvider><EditUserDrawer open user={{ id: "alice", displayName: "Alice" }} onClose={vi.fn()} onSuccess={onSuccess} /></DialogProvider>);
  const input = await screen.findByLabelText("admin.v2.task_capacity_label");
  expect((input as HTMLInputElement).value).toBe("5");
  fireEvent.change(input, { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "admin.v2.save" }));
  await waitFor(() => expect(updateControlPanelUser).toHaveBeenCalledWith(expect.objectContaining({ userId: "alice", maxConcurrentTasks: 2 })));
  expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrentTasks: 2 }));
});
