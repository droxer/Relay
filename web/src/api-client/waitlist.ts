import type {
  CurrentUser,
  WaitlistEntry,
  WaitlistInvite,
  WaitlistInviteResult,
  WaitlistJoinInput,
  WaitlistListResponse,
  WaitlistStatus,
} from "../types.ts";
import { apiJson } from "./client.ts";

/* ---------- Waitlist (public) ------------------------------------------ */

/** Ask for access. The answer is the same `202` whether the email is new or
    already known, so the caller must not read anything into it. */
export function joinWaitlist(input: WaitlistJoinInput): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>("/waitlist", { method: "POST", body: input });
}

/* The token travels in a POST body, never the path, so no access log keeps a
   redeemable invite. */
export function getWaitlistInvite(token: string, signal?: AbortSignal): Promise<{ invite: WaitlistInvite }> {
  return apiJson<{ invite: WaitlistInvite }>("/waitlist/invites/lookup", {
    method: "POST",
    body: { token },
    signal,
  });
}

/** Redeem an invite. Sets the session cookie exactly as `/auth/login` does. */
export function acceptWaitlistInvite(
  token: string,
  input: { handle: string; password: string },
): Promise<{ user: CurrentUser }> {
  return apiJson<{ user: CurrentUser }>("/waitlist/invites/accept", {
    method: "POST",
    body: { token, ...input },
  });
}

/* ---------- Waitlist (admin) ------------------------------------------- */

export interface WaitlistListQuery {
  status: WaitlistStatus;
  q?: string;
  limit: number;
  offset: number;
}

export function listWaitlist(query: WaitlistListQuery, signal?: AbortSignal): Promise<WaitlistListResponse> {
  const params = new URLSearchParams({
    status: query.status,
    limit: String(query.limit),
    offset: String(query.offset),
  });
  if (query.q?.trim()) params.set("q", query.q.trim());
  return apiJson<WaitlistListResponse>(`/admin/waitlist?${params.toString()}`, { signal });
}

/** Invite, re-invite, or resend — each rotates the token. */
export function inviteWaitlistEntry(id: string): Promise<WaitlistInviteResult> {
  return apiJson<WaitlistInviteResult>(`/admin/waitlist/${encodeURIComponent(id)}/invite`, { method: "POST" });
}

export function inviteWaitlistBatch(count: number): Promise<{ invites: WaitlistInviteResult[] }> {
  return apiJson<{ invites: WaitlistInviteResult[] }>("/admin/waitlist/invite-batch", {
    method: "POST",
    body: { count },
  });
}

export function declineWaitlistEntry(id: string): Promise<{ entry: WaitlistEntry }> {
  return apiJson<{ entry: WaitlistEntry }>(`/admin/waitlist/${encodeURIComponent(id)}/decline`, { method: "POST" });
}

export function updateWaitlistNote(id: string, adminNote: string | null): Promise<{ entry: WaitlistEntry }> {
  return apiJson<{ entry: WaitlistEntry }>(`/admin/waitlist/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { adminNote },
  });
}

/** Erase: a hard delete, for data-subject requests. */
export function eraseWaitlistEntry(id: string): Promise<{ ok: true }> {
  return apiJson<{ ok: true }>(`/admin/waitlist/${encodeURIComponent(id)}`, { method: "DELETE" });
}
