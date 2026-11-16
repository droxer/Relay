import type { RelaySession } from "../types";
import { sessionGuard } from "../api-client/responseShape";

export type CachedSessionDetail = { snapshot: RelaySession; hydratedAt: number };
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const storageKey = (owner: string) => `relay.thread-details.v1:${owner}`;

// Per-account, per-tab cache. Storage may be unavailable or full; neither
// should prevent opening a conversation. Bound both count and serialized size.
export function readSessionDetails(owner: string): CachedSessionDetail[] {
  try {
    const rows: unknown = JSON.parse(sessionStorage.getItem(storageKey(owner)) ?? "[]");
    if (!Array.isArray(rows)) return [];
    const now = Date.now();
    return rows.filter((row): row is CachedSessionDetail => {
      if (!row || !Number.isFinite(row.hydratedAt) || row.hydratedAt > now || now - row.hydratedAt >= MAX_AGE_MS) return false;
      try {
        sessionGuard(row.snapshot);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function writeSessionDetail(owner: string, detail: CachedSessionDetail): void {
  try {
    const rows = [detail, ...readSessionDetails(owner).filter(row => row.snapshot.id !== detail.snapshot.id)].slice(0, 8);
    let serialized = JSON.stringify(rows);
    while (serialized.length > 2_000_000 && rows.length > 0) {
      rows.pop();
      serialized = JSON.stringify(rows);
    }
    sessionStorage.setItem(storageKey(owner), serialized);
  } catch {
    // In-memory QueryClient data remains usable when browser storage fails.
  }
}

export function removeSessionDetail(owner: string, sessionId: string): void {
  try {
    const rows = readSessionDetails(owner).filter(row => row.snapshot.id !== sessionId);
    sessionStorage.setItem(storageKey(owner), JSON.stringify(rows));
  } catch {
    // Revocation/deletion must still work when storage is unavailable.
  }
}
