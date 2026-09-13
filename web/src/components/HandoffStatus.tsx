"use client";

import { useTranslation } from "react-i18next";
import type { RelaySession } from "../types";
import { deriveHandoffStatus } from "../lib/handoffStatus";

export function HandoffStatus({ session }: { session: RelaySession | undefined }) {
  const { t } = useTranslation();
  const handoff = deriveHandoffStatus(session);
  if (!handoff) return null;
  return (
    <div className="handoff-panel" role="status" aria-live="polite">
      <div className="handoff-panel-title">{t(`handoff.status_${handoff.status}`, { agent: handoff.target })}</div>
      {handoff.note ? <p>{handoff.note}</p> : null}
      {handoff.reason ? <p>{handoff.reason}</p> : null}
    </div>
  );
}
