import { useState } from "react";
import type { TFunction } from "i18next";
import type { RelaySession } from "../types";
import { ProjectMessagesAccumulator } from "../lib/projectMessages";

/** Render-local projections retain suffix processing without mutating committed state. */
export function useProjectedMessages(session: RelaySession | undefined, t: TFunction) {
  const [projection, setProjection] = useState(() => ({
    session,
    t,
    ...new ProjectMessagesAccumulator().advance(session, t),
  }));
  if (projection.session !== session || projection.t !== t) {
    const next = { session, t, ...projection.accumulator.advance(session, t) };
    setProjection(next);
    return next.messages;
  }
  return projection.messages;
}
