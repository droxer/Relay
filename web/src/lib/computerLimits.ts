/** Bounds for the personal-computer limit, mirroring the backend's range in
    `relay/persistence/org_settings_store.py`. Kept as constants here so the
    admin forms can validate before a round trip; the backend stays the
    authority and rejects anything outside the range regardless. */
export const MIN_LOCAL_COMPUTERS = 0;
export const MAX_LOCAL_COMPUTERS_CEILING = 50;

/** Parse a limit typed into an admin form.

    Returns `null` for an empty field — which the user forms read as "no
    override, follow the org default" — and `undefined` for text that is not a
    limit at all, so a caller can tell "cleared" from "invalid". */
export function parseLimitInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) return undefined;
  if (parsed < MIN_LOCAL_COMPUTERS || parsed > MAX_LOCAL_COMPUTERS_CEILING) return undefined;
  return parsed;
}

/** Bounds for the automatic task-round budget, mirroring the backend's range in
    `relay/persistence/org_settings_store.py`. */
export const MIN_TASK_ROUNDS = 1;
export const MAX_TASK_ROUNDS_CEILING = 50;
