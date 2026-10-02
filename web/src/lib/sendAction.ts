import type { RelaySession } from "../types.js";

type SendAction = { kind: "append"; sessionId: string } | { kind: "create" };

type SessionLike = Pick<RelaySession, "id"> & { archived?: boolean };

export function chooseSendAction(input: {
  activeSessionId: string | null;
  session: SessionLike | undefined;
}): SendAction {
  const { activeSessionId, session } = input;
  if (activeSessionId && session && !session.archived) {
    return { kind: "append", sessionId: activeSessionId };
  }
  return { kind: "create" };
}

export function suppressActiveSessionDuringPendingSend(action: SendAction): boolean {
  return action.kind === "create";
}

// The thread the URL must name while a send is in flight. A create stays on
// the staged-new path (`null` → /threads/new) so `composingNew` survives the
// round trip: routing to the bare /threads route instead let the location
// parser reset it, and the optimistic user turn then rendered inside the
// previously active thread until the create resolved and snapped the view
// back to the new one.
export function sendThreadSessionId(action: SendAction): string | null {
  return action.kind === "append" ? action.sessionId : null;
}
