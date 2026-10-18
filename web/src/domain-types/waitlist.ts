/* Waitlist. An entry is a person's request to try Relay, keyed by email; it
   owns nothing until an accepted invite turns it into an Account (`accountId`).
   Expiry is derived (`inviteExpired`), never a status of its own. */
export type WaitlistStatus = "waiting" | "invited" | "joined" | "declined";
/** `queued` while a batch invite's email is still to be sent. */
export type WaitlistDeliveryStatus = "queued" | "sent" | "bounced" | "failed" | "skipped";

export interface WaitlistEntry {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  role: string | null;
  useCase: string | null;
  source: string | null;
  locale: string | null;
  status: WaitlistStatus;
  inviteExpiresAt: string | null;
  inviteExpired: boolean;
  invitedAt: string | null;
  invitedByUserId: string | null;
  accountId: string | null;
  adminNote: string | null;
  lastDeliveryStatus: WaitlistDeliveryStatus | null;
  lastDeliveryError: string | null;
  lastDeliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WaitlistListResponse {
  entries: WaitlistEntry[];
  /** Rows matching the request's status and query, across every page. */
  total: number;
  counts: Record<WaitlistStatus, number>;
}

/** One issued invite. `inviteUrl` carries the plaintext token, so it is shown
    once and never fetched again — re-inviting rotates the token. */
export interface WaitlistInviteResult {
  entry: WaitlistEntry;
  inviteUrl: string;
  delivery: { status: WaitlistDeliveryStatus; error: string | null };
}

/** An admin's direct invitation; `locale` picks the email's language. */
export interface InviteByEmailInput {
  email: string;
  name?: string;
  locale?: string;
}

export interface WaitlistJoinInput {
  email: string;
  name?: string;
  company?: string;
  role?: string;
  useCase?: string;
  source?: string;
  locale?: string;
  /** The honeypot: always sent, whatever it holds. */
  website: string;
}

export interface WaitlistInvite {
  email: string;
  name: string | null;
  suggestedHandle: string;
  expiresAt: string;
}
