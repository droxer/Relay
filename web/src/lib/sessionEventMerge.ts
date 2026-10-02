import type { RelaySession } from "../types.js";

type RelayEvent = RelaySession["events"][number];

type SessionEventMergeResult = {
  sessions: RelaySession[] | undefined;
  consumed: boolean;
};

type SessionEventsMergeResult = {
  sessions: RelaySession[] | undefined;
  consumed: number;
};

/** Maintain event ids incrementally while tolerating poll-driven cache replacement. */
export class SessionEventIdIndex {
  private readonly ids = new Set<string>();
  private indexedCount = 0;
  private boundaryId: string | undefined;

  constructor(events: RelayEvent[] = []) {
    this.synchronize(events);
  }

  synchronize(events: RelayEvent[]): void {
    const appendOnly = this.indexedCount <= events.length
      && (this.indexedCount === 0 || events[this.indexedCount - 1]?.id === this.boundaryId);
    if (!appendOnly) {
      this.ids.clear();
      this.indexedCount = 0;
    }
    for (let index = this.indexedCount; index < events.length; index += 1) {
      this.ids.add(events[index].id);
    }
    this.indexedCount = events.length;
    this.boundaryId = events.at(-1)?.id;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
}

export function mergeSessionEventsIntoSessions(
  sessions: RelaySession[] | undefined,
  sessionId: string,
  events: RelayEvent[],
  applyEvent: (session: RelaySession, event: RelayEvent) => RelaySession,
  applyEvents?: (session: RelaySession, events: RelayEvent[]) => RelaySession,
  eventIds?: SessionEventIdIndex,
): SessionEventsMergeResult {
  if (!sessions) return { sessions, consumed: 0 };
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) return { sessions, consumed: 0 };

  const known = eventIds ?? new SessionEventIdIndex();
  known.synchronize(target.events);
  const queued = new Set<string>();
  const fresh: RelayEvent[] = [];
  for (const event of events) {
    if (known.has(event.id) || queued.has(event.id)) continue;
    queued.add(event.id);
    fresh.push(event);
  }
  const consumed = fresh.length;
  if (consumed === 0) return { sessions, consumed };
  const merged = applyEvents
    ? applyEvents(target, fresh)
    : fresh.reduce(applyEvent, target);
  eventIds?.synchronize(merged.events);
  return {
    sessions: sessions.map((session) => session.id === sessionId ? merged : session),
    consumed,
  };
}

export function mergeSessionEventIntoSessions(
  sessions: RelaySession[] | undefined,
  sessionId: string,
  event: RelayEvent,
  applyEvent: (session: RelaySession, event: RelayEvent) => RelaySession,
): SessionEventMergeResult {
  if (!sessions) return { sessions, consumed: false };
  let changed = false;
  let consumed = false;
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    consumed = true;
    if (session.events.some((existing) => existing.id === event.id)) return session;
    changed = true;
    return applyEvent(session, event);
  });
  return { sessions: changed ? next : sessions, consumed };
}
