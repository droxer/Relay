/** Pure rules for the waitlist: the public form's limits and context, the
    invite token's one trip through the URL fragment, and the admin queue's
    grouping. The backend (`backend/relay/services/waitlist.py`) stays the
    authority; these mirror its limits so the form can answer before a round
    trip, and a value the server would refuse never leaves the browser. */
import type { Tone, WaitlistDeliveryStatus, WaitlistEntry, WaitlistJoinInput, WaitlistStatus } from "../types.js";
import type { Page } from "./pagination.ts";

/** Field caps, mirroring the backend's column limits. */
export const WAITLIST_LIMITS = {
  email: 254,
  name: 120,
  company: 120,
  role: 80,
  useCase: 1000,
  source: 120,
  adminNote: 1000,
} as const;

/** The admin "Invite next N" bounds, mirroring `invite-batch`'s 1–50. */
export const MIN_INVITE_BATCH = 1;
export const MAX_INVITE_BATCH = 50;

/** The queue reads oldest-first within a status, and the bands read in the
    order an entry moves through them. */
export const WAITLIST_STATUS_ORDER: readonly WaitlistStatus[] = ["waiting", "invited", "joined", "declined"];

/** Waiting is the admin's to-do, so it is the one band that asks for
    attention; joined is done; declined is closed, not failed. */
export const WAITLIST_STATUS_TONE: Record<WaitlistStatus, Tone> = {
  waiting: "warn",
  invited: "info",
  joined: "good",
  declined: "neutral",
};

const DELIVERY_TONE: Record<WaitlistDeliveryStatus, Tone> = {
  queued: "info",
  sent: "good",
  skipped: "neutral",
  bounced: "bad",
  failed: "bad",
};

/** Shape only — one `@`, something on both sides, a dot in the domain. The
    server normalizes and is the real check. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isWaitlistEmail(raw: string): boolean {
  const email = raw.trim();
  return email.length <= WAITLIST_LIMITS.email && EMAIL_SHAPE.test(email);
}

export type WaitlistField = "email" | "name" | "company" | "role" | "useCase";
export type WaitlistFieldProblem = "required" | "invalid" | "too_long";
export type WaitlistFields = Record<WaitlistField, string>;

export const EMPTY_WAITLIST_FIELDS: WaitlistFields = { email: "", name: "", company: "", role: "", useCase: "" };

/** Every field the form would refuse, keyed by field. Empty when it may send. */
export function waitlistFieldProblems(fields: WaitlistFields): Partial<Record<WaitlistField, WaitlistFieldProblem>> {
  const problems: Partial<Record<WaitlistField, WaitlistFieldProblem>> = {};
  const email = fields.email.trim();
  if (!email) problems.email = "required";
  else if (email.length > WAITLIST_LIMITS.email) problems.email = "too_long";
  else if (!isWaitlistEmail(email)) problems.email = "invalid";
  for (const field of ["name", "company", "role", "useCase"] as const) {
    if (fields[field].trim().length > WAITLIST_LIMITS[field]) problems[field] = "too_long";
  }
  return problems;
}

/** The request body: trimmed, empty optionals dropped, and the honeypot sent
    as-is — a bot that filled it must look exactly like a person to itself. */
export function waitlistJoinInput(
  fields: WaitlistFields,
  context: { honeypot: string; source?: string; locale?: string },
): WaitlistJoinInput {
  const optional = (value: string) => value.trim() || undefined;
  return {
    email: fields.email.trim(),
    name: optional(fields.name),
    company: optional(fields.company),
    role: optional(fields.role),
    useCase: optional(fields.useCase),
    source: context.source,
    locale: context.locale,
    website: context.honeypot,
  };
}

/** Where a visitor came from: `utm_source` when the link carried one, else
    the referring host — unless the referrer is Relay itself, which says
    nothing about how they found it. */
export function waitlistSource(
  location: { search: string; origin: string },
  referrer: string,
): string | undefined {
  const utm = new URLSearchParams(location.search).get("utm_source")?.trim();
  if (utm) return utm.slice(0, WAITLIST_LIMITS.source);
  if (!referrer) return undefined;
  try {
    const url = new URL(referrer);
    if (url.origin === location.origin || !url.hostname) return undefined;
    return url.hostname.slice(0, WAITLIST_LIMITS.source);
  } catch {
    return undefined;
  }
}

/** The UI language as the backend's locale enum. */
export function waitlistLocale(language: string | undefined): InviteLocale {
  return language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** URL-safe characters only; anything else is not a token this backend minted. */
const INVITE_TOKEN_SHAPE = /^[A-Za-z0-9._~-]{1,512}$/;

/** The invite token from `#token=…`. It rides in the fragment so it is never
    sent to a server or written to an access log. */
export function inviteTokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token")?.trim();
  return token && INVITE_TOKEN_SHAPE.test(token) ? token : null;
}

export function deliveryTone(status: WaitlistDeliveryStatus): Tone {
  return DELIVERY_TONE[status];
}

export function deliveryLabelKey(status: WaitlistDeliveryStatus): string {
  return `admin.waitlist.delivery_${status}`;
}

/** Whether an invited entry's link still works. `null` outside `invited`. */
export function inviteState(entry: Pick<WaitlistEntry, "status" | "inviteExpired">): "live" | "expired" | null {
  if (entry.status !== "invited") return null;
  return entry.inviteExpired ? "expired" : "live";
}

/** The first row of a 1-based page. */
export function pageOffset(page: number, size: number): number {
  return (Math.max(1, Math.floor(page) || 1) - 1) * size;
}

/** A server-paged slice in the shape `<Pagination>` reads. The server already
    applied status, search, and offset, so only the arithmetic is left. */
export function serverPage<T>(items: T[], page: number, total: number, size: number): Page<T> {
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const from = items.length === 0 ? 0 : (current - 1) * size + 1;
  return {
    items,
    page: current,
    pageCount,
    total,
    from,
    to: items.length === 0 ? 0 : from + items.length - 1,
    needed: pageCount > 1,
  };
}

/** Parse the "Invite next N" field; `null` for anything outside 1–50. */
export function parseInviteBatch(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const count = Number(raw.trim());
  return count >= MIN_INVITE_BATCH && count <= MAX_INVITE_BATCH ? count : null;
}

/** The languages an invite email is written in, mirroring the backend's
    `SUPPORTED_LOCALES`. */
export const INVITE_LOCALES = ["en", "zh-CN"] as const;
export type InviteLocale = (typeof INVITE_LOCALES)[number];

/** The `source` the backend stamps on an entry an admin invited by email
    (`ADMIN_INVITE_SOURCE`), so the queue can tell it from a request. */
export const ADMIN_INVITE_SOURCE = "admin-invite";

export function isAdminInvite(entry: Pick<WaitlistEntry, "source">): boolean {
  return entry.source === ADMIN_INVITE_SOURCE;
}

/** Why the invite-by-email address would be refused, or `null` to send it. */
export function inviteEmailProblem(raw: string): "required" | "invalid" | null {
  if (!raw.trim()) return "required";
  return isWaitlistEmail(raw) ? null : "invalid";
}

/** A delivery the admin has to act on: the link reached nobody, so the
    reason is shown in full rather than behind a tooltip. */
export function deliveryFailed(status: WaitlistDeliveryStatus | null | undefined): boolean {
  return status === "failed" || status === "bounced";
}
