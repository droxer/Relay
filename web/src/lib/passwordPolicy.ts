/** The password rule, mirroring `backend/relay/security/passwords.py`.

    Every rule is mirrored here EXCEPT the common-password blocklist: a few
    hundred entries duplicated in two languages would drift the first time one
    side is edited, and the check it powers is not one the form has to win. The
    backend is the authority and refuses those with a message this drawer
    surfaces; what the form answers locally is the part it can be sure of.

    Shaped after NIST SP 800-63B, so there are deliberately no composition
    rules — `correct horse battery staple` is a better password than
    `Passw0rd!` and the policy should not say otherwise. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

/** The shortest run that counts as a straight sequence. Matches
    `_MIN_SEQUENCE_RUN`. */
const MIN_SEQUENCE_RUN = 5;

const SEQUENCE_ALPHABETS = [
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
];

/** Why a password was refused, or `null` when the local rules all pass. The
    backend may still refuse it for being a commonly guessed secret. */
type PasswordProblem = "short" | "long" | "identifier" | "degenerate";

export function passwordProblem(
  password: string,
  identifiers: ReadonlyArray<string | null | undefined> = [],
): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) return "short";
  if (password.length > MAX_PASSWORD_LENGTH) return "long";
  if (containsIdentifier(password, identifiers)) return "identifier";
  if (isDegenerate(password)) return "degenerate";
  return null;
}

export function isValidPassword(
  password: string,
  identifiers: ReadonlyArray<string | null | undefined> = [],
): boolean {
  return passwordProblem(password, identifiers) === null;
}

/** True when the password is built out of a name the account already has —
    the first guess anyone would make. Short identifiers are skipped: a
    two-letter handle would reject half the dictionary. */
function containsIdentifier(
  password: string,
  identifiers: ReadonlyArray<string | null | undefined>,
): boolean {
  const lowered = password.toLowerCase();
  return identifiers.some((identifier) =>
    identifierTokens(identifier).some((token) => lowered.includes(token)),
  );
}

function identifierTokens(identifier: string | null | undefined): string[] {
  // An email is its local part; the domain is shared by the whole company and
  // would reject far too much.
  const raw = (identifier ?? "").trim().toLowerCase().split("@")[0] ?? "";
  if (!raw) return [];
  const words = raw.split(/[^a-z0-9]+/).filter(Boolean);
  return [raw, ...words].filter((token) => token.length >= 4);
}

function isDegenerate(password: string): boolean {
  const lowered = password.toLowerCase();
  if (new Set(lowered).size === 1) return true;
  return SEQUENCE_ALPHABETS.some((alphabet) => {
    const reversed = [...alphabet].reverse().join("");
    for (let start = 0; start <= lowered.length - MIN_SEQUENCE_RUN; start += 1) {
      const window = lowered.slice(start, start + MIN_SEQUENCE_RUN);
      if (alphabet.includes(window) || reversed.includes(window)) return true;
    }
    return false;
  });
}
