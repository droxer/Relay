"use client";

import { useTranslation } from "react-i18next";
import type { deriveHandoffStatus } from "../lib/handoffStatus";

export function HandoffStatus({ handoff }: { handoff: ReturnType<typeof deriveHandoffStatus> }) {
  const { t } = useTranslation();
  if (!handoff) return null;
  return (
    <div className="handoff-panel" role="status" aria-live="polite">
      <div className="handoff-panel-title">{t(`handoff.status_${handoff.status}`, { agent: handoff.target })}</div>
      {handoff.note ? <p>{handoff.note}</p> : null}
      {handoff.reason ? <p>{handoff.reason}</p> : null}
    </div>
  );
}
