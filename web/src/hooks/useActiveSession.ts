import { useEffect, useRef } from "react";
import { activeSessionStorageKey, useRelayStore } from "../lib/store.ts";

type SessionLike = { id: string; archived?: boolean; createdAt?: string; updatedAt?: string };

export function pickInitialActiveSessionId(
  stored: string | null,
  sessions: readonly SessionLike[],
): string | null {
  if (stored) {
    const hit = sessions.find((s) => s.id === stored && !s.archived);
    if (hit) return hit.id;
  }
  const eligible = sessions
    .filter((s) => !s.archived)
    .slice()
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
  return eligible[0]?.id ?? null;
}

// Whether the effect below should pick an opening thread. The pick is
// per-employee and one-shot: the session list changes on every poll tick and
// every streamed update, and re-deriving on each of those would drag the
// selection back to the most recent thread — undoing an explicit "new
// thread", which deliberately clears both the selection and its stored
// id. An empty list means the first load has not landed yet, so wait.
export function shouldDeriveActiveSession(input: {
  employeeId: string;
  derivedFor: string | null;
  sessionCount: number;
}): boolean {
  if (!input.employeeId) return false;
  if (input.derivedFor === input.employeeId) return false;
  return input.sessionCount > 0;
}

// Picks the thread an employee sees on arrival, once per employee. The value
// itself lives in the relay store (next to selectedSessionId and composingNew)
// so the thread-selection actions there can move all three together.
export function useActiveSession(employeeId: string, sessions: readonly SessionLike[]) {
  const activeSessionId = useRelayStore((s) => s.activeSessionId);
  const setActiveSessionId = useRelayStore((s) => s.setActiveSessionId);
  const adoptActiveSessionId = useRelayStore((s) => s.adoptActiveSessionId);
  const derivedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!employeeId) {
      derivedForRef.current = null;
      adoptActiveSessionId(null);
      return;
    }
    if (!shouldDeriveActiveSession({
      employeeId,
      derivedFor: derivedForRef.current,
      sessionCount: sessions.length,
    })) return;
    derivedForRef.current = employeeId;
    const stored = typeof window !== "undefined"
      ? window.localStorage.getItem(activeSessionStorageKey(employeeId))
      : null;
    adoptActiveSessionId(pickInitialActiveSessionId(stored, sessions));
  }, [adoptActiveSessionId, employeeId, sessions]);

  return { activeSessionId, setActiveSessionId };
}
