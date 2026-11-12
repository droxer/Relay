/** A count badge on a glyph stops counting here; past it the badge reads
    "9+". One cap for every such badge — the rail's Home count and the
    notification bell sit a few squares apart, and used to disagree (99+ and
    9+) about the same kind of number. */
export const COUNT_BADGE_CAP = 9;

/** The badge's text: the count, capped at "9+"; empty when there is nothing
    to count, so callers can render the badge only when this is truthy. */
export function countBadgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > COUNT_BADGE_CAP ? `${COUNT_BADGE_CAP}+` : String(Math.floor(count));
}
