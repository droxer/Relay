/** The one account-email rule the web mirrors from the backend
    (`backend/relay/core/email_address.py`): trim, lowercase, then require a
    plain `local@domain.tld` shape with no whitespace, control, or characters
    that would smuggle a display name or a second recipient. The backend
    normalizes and is the real check; this only answers before a round trip. */
export const MAX_EMAIL_LENGTH = 254;

const EMAIL_SHAPE = /^[^@\s,;<>()"\\\x00-\x1f\x7f]+@[^@\s,;<>()"\\\x00-\x1f\x7f]+\.[^@\s,;<>()"\\\x00-\x1f\x7f]+$/;

export function isValidEmailAddress(raw: string): boolean {
  const email = raw.trim().toLowerCase();
  return email.length > 0 && email.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(email);
}

export type EmailProblem = "required" | "invalid";

/** Why an account email would be refused, or `null` when it may be sent. */
export function emailProblem(raw: string): EmailProblem | null {
  if (!raw.trim()) return "required";
  return isValidEmailAddress(raw) ? null : "invalid";
}
