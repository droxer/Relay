import type { Language, Theme } from "../lib/appStorage.ts";
import type { CurrentUser } from "../types.ts";
import { apiJson } from "./client.ts";

/** What a signed-out visitor may do. `waitlistEnabled` is absent on a backend
    that predates the waitlist, which reads as off. */
export interface AuthStatus {
  requiresBootstrap: boolean;
  waitlistEnabled: boolean;
}

export async function getAuthStatus(signal?: AbortSignal): Promise<AuthStatus> {
  const status = await apiJson<Partial<AuthStatus>>("/auth/status", { signal });
  return {
    requiresBootstrap: status.requiresBootstrap === true,
    waitlistEnabled: status.waitlistEnabled === true,
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
