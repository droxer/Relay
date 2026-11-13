import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { publicRequestError } from "../src/components/waitlist/waitlistErrors";
import type { TFunction } from "i18next";
import { EditUserDrawer } from "../src/components/admin/EditUserDrawer";
import type { UserRecord } from "../src/types";
vi.mock("../src/components/ui/Drawer", () => ({ Drawer: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../src/components/admin/UserPasswordReset", () => ({ UserPasswordReset: () => null }));
vi.mock("../src/hooks/useUnsavedChangesGuard", () => ({ useUnsavedChangesGuard: () => async () => true }));
import * as api from "../src/api";
import { FirstAdminSetupScreen, AdminLoginScreen } from "../src/components/admin/AdminAuthScreens";

it("submits the required email when initializing the first administrator", async () => {
  const bootstrap = vi.spyOn(api, "bootstrapUser").mockResolvedValue({ user: {} } as never);
  const done = vi.fn();
  render(<FirstAdminSetupScreen onBootstrapped={done} onSwitchToLogin={vi.fn()} />);
  const email = screen.getByLabelText(/admin.email/);
  expect(email.hasAttribute("required")).toBe(true);
  fireEvent.change(email, { target: { value: "Admin@example.com" } });
  fireEvent.change(screen.getByLabelText("admin.username"), { target: { value: "owner" } });
  fireEvent.change(screen.getByLabelText("admin.bootstrap_token"), { target: { value: "setup-token" } });
  fireEvent.change(screen.getByLabelText("admin.password"), { target: { value: "Strong-password-123" } });
  fireEvent.click(screen.getByRole("button", { name: "admin.create_admin" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(bootstrap).toHaveBeenCalledWith({ token: "setup-token", username: "owner", email: "Admin@example.com", password: "Strong-password-123" });
});

it.each(["owner", "owner@example.com"])("keeps username and email login through the compatible identifier field: %s", async (identifier) => {
  const login = vi.spyOn(api, "login").mockResolvedValue({ user: {} } as never);
  render(<AdminLoginScreen onLogin={vi.fn()} needsBootstrap={false} onSwitchToBootstrap={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("admin.username_or_email"), { target: { value: identifier } });
  fireEvent.change(screen.getByLabelText("admin.password"), { target: { value: "password" } });
  fireEvent.click(screen.getByRole("button", { name: "admin.sign_in" }));
  await waitFor(() => expect(login).toHaveBeenCalledWith({ username: identifier, password: "password" }));
});

it("distinguishes a duplicate email from a taken handle on invite acceptance", () => {
  const t = ((key: string) => key) as TFunction;
  expect(publicRequestError(new api.RelayApiError("An account with this email already exists.", 409), t)).toBe("waitlist.error_email_taken");
  expect(publicRequestError(new api.RelayApiError("username already exists.", 409), t)).toBe("username already exists.");
});

it("does not submit an unchanged empty email when editing a legacy user", async () => {
  const user = { id: "legacy", displayName: "Legacy", email: null } as unknown as UserRecord;
  const update = vi.spyOn(api, "updateControlPanelUser").mockResolvedValue({ user } as never);
  const { container } = render(<EditUserDrawer open user={user} onClose={vi.fn()} onSuccess={vi.fn()} />);
  fireEvent.submit(container.querySelector("form")!);
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0][0]).not.toHaveProperty("email");
});
