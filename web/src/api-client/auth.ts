import type { Language, Theme } from "../lib/appStorage.ts";
import type { CurrentUser } from "../types.ts";
import { apiJson } from "./client.ts";

/** What a signed-out visitor may do. A flag absent on an older backend reads
    as off. `passwordResetEnabled` is true only while the server can email. */
export interface AuthStatus {
  requiresBootstrap: boolean;
  waitlistEnabled: boolean;
  passwordResetEnabled: boolean;
}

export async function getAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
  const status = await apiJson<Partial<AuthStatus>>("/auth/status", { signal });
  return {
    requiresBootstrap: status.requiresBootstrap === true,
    waitlistEnabled: status.waitlistEnabled === true,
    passwordResetEnabled: status.passwordResetEnabled === true,
  };
}

/** Server switches every signed-in user's UI depends on. */
export interface SessionCapabilities {
  /** False when the server limits new automation triggers to schedules. */
  automationTriggers?: boolean;
}

export function getMe(signal?: AbortSignal): Promise<{ authenticated: boolean; user?: CurrentUser; capabilities?: SessionCapabilities }> {
  return apiJson<{ authenticated: boolean; user?: CurrentUser; capabilities?: SessionCapabilities }>("/auth/me", { signal });
}

export function updateUserPreferences(input: { theme?: Theme; language?: Language }): Promise<{ user: CurrentUser }> {
  return apiJson<{ user: CurrentUser }>("/auth/preferences", {
    method: "PATCH",
    body: input,
  });
}

export function bootstrapUser(input: { token: string; username: string; password: string }): Promise<{ user: CurrentUser }> {
  return apiJson<{ user: CurrentUser }>("/auth/bootstrap", {
    method: "POST",
    body: input,
  });
}

export function login(input: { username: string; password: string }): Promise<{ user: CurrentUser }> {
  return apiJson<{ user: CurrentUser }>("/auth/login", {
    method: "POST",
    body: input,
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return apiJson<{ ok: boolean }>("/auth/logout", { method: "POST" });
}

/* ---------- Password reset (public) ------------------------------------ */

/** Ask for a reset link. The answer is the same `202` whether or not an
    account matched, so the caller must not read anything into it. */
export function requestPasswordReset(input: { identifier: string; locale?: string }): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>("/auth/password-reset", { method: "POST", body: input });
}

/** Who a live link resets. The token travels in a POST body, never the path,
    so no access log keeps a redeemable link. */
export function getPasswordReset(token: string, signal?: AbortSignal): Promise<{ reset: PasswordResetLink }> {
  return apiJson<{ reset: PasswordResetLink }>("/auth/password-reset/lookup", {
    method: "POST",
    body: { token },
    signal,
  });
}

/** Set the new password. It signs every session out and signs nobody in. */
export function completePasswordReset(token: string, password: string): Promise<{ ok: true; username: string }> {
  return apiJson<{ ok: true; username: string }>("/auth/password-reset/complete", {
    method: "POST",
    body: { token, password },
  });
}

export interface PasswordResetLink {
  username: string;
  expiresAt: string;
}
