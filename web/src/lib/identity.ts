/**
 * Deterministic monogram for entities that have no uploaded profile
 * image (agents, agent teams, task assignees).
 *
 * A pure function of the display name, so an identity keeps the same monogram
 * everywhere it appears — and across reloads — without storing anything
 * server-side. Agents and teams no longer take a per-name mark at all: their
 * default is the class glyph in IdentityMark.tsx. This stays for the human
 * initials in UserAvatar and the assignee chip.
 */

/** Word boundaries used by handles (`growth.lead`, `claude-main`) and names. */
const NAME_SEPARATORS = /[._\-\s/]+/;

/**
 * Two-letter abbreviation of a display name: initials when the name has
 * several words (`Growth Team` → `GT`), otherwise the first two characters
 * of the single word (`claude` → `CL`, `研究组` → `研究`). Falls back to `?`
 * for an empty name so the mark never renders as an empty box.
 */
export function identityMonogram(name: string, maxLetters = 2): string {
  const parts = name.trim().split(NAME_SEPARATORS).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return [...parts[0]!].slice(0, maxLetters).join("").toUpperCase();
  return parts
    .slice(0, maxLetters)
    .map((part) => [...part][0]!.toUpperCase())
    .join("");
}
