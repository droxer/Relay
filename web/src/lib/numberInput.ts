/**
 * The limit fields hold their value as a string draft, because "" means
 * something there — "no override, use the org default" — and is not zero.
 * The number field speaks number | null; these two are the only translation.
 */
export function numberFromDraft(draft: string): number | null {
  if (draft.trim() === "") return null;
  const value = Number(draft);
  return Number.isFinite(value) ? value : null;
}

export function draftFromNumber(value: number | null): string {
  return value === null ? "" : String(value);
}
