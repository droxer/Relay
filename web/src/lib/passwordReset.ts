/* The forgotten-password pages' pure rules: what the request form accepts,
   how a link's token is read, and the "password updated" hand-off to the
   sign-in screen. Kept apart from the components so they test without a DOM. */

import { inviteTokenFromHash } from "./waitlist.ts";

/** The server refuses longer identifiers; an email is at most 254 characters. */
export const MAX_RESET_IDENTIFIER_LENGTH = 254;

export type ResetIdentifierProblem = "required" | "too_long";

/** A username or an email. The server decides which, and its answer never
    says whether either exists, so the form checks only the shape. */
export function resetIdentifierProblem(value: string): ResetIdentifierProblem | null {
  const trimmed = value.trim();
  if (!trimmed) return "required";
  if (trimmed.length > MAX_RESET_IDENTIFIER_LENGTH) return "too_long";
  return null;
}

/** `#token=…` from a reset link. Same URL-safe shape as an invite token. */
export function resetTokenFromHash(hash: string): string | null {
  return inviteTokenFromHash(hash);
}

/* The account a reset just finished for, so the sign-in screen can say so and
   prefill the username. Module state, not storage or the URL: it only has to
   survive the in-app navigation to /login, and a reload should forget it. */
let completedResetUsername: string | null = null;

export function rememberCompletedReset(username: string): void {
  completedResetUsername = username;
}

export function completedReset(): string | null {
  return completedResetUsername;
}

export function forgetCompletedReset(): void {
  completedResetUsername = null;
}
