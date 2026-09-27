"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentName, RelaySession } from "../types";
import { deriveTeamHandoff } from "../lib/teamHandoff";
import { labelForAgentRun } from "../lib/agentDisplayNames";
import { ActionRoute, ICON } from "./icons";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";

// Seconds before the elapsed counter shows: a gap shorter than this reads as
// one motion, and a ticking "1s" would be noise.
const ELAPSED_AFTER_SECONDS = 3;
const TICK_MS = 1000;

function useElapsedSeconds(since: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [since]);
  const start = since ? Date.parse(since) : Number.NaN;
  return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / TICK_MS)) : 0;
}

type Props = {
  session: RelaySession | null | undefined;
  logicalAgentNames: Record<string, string>;
  logicalAgentImages: Record<string, string>;
  agentDisplayNames: Partial<Record<AgentName, string>>;
};

/**
 * Live tail row for the gap between two team members' turns. It sits on the
 * transcript rail where the next turn will land, so the thread shows the
 * baton moving instead of going quiet.
 */
export function TeamHandoffCue({ session, logicalAgentNames, logicalAgentImages, agentDisplayNames }: Props) {
  const { t } = useTranslation();
  const handoff = deriveTeamHandoff(session);
  const elapsed = useElapsedSeconds(handoff?.since);
  if (!handoff) return null;

  const from = labelForAgentRun({ agent: handoff.fromAgent, agentId: handoff.fromAgentId }, logicalAgentNames, agentDisplayNames);
  const to = handoff.toAgentId ? logicalAgentNames[handoff.toAgentId] : undefined;
  const label = to ? t("transcript.handoff_to", { from, to }) : t("transcript.handoff_open", { from });
  const image = handoff.toAgentId ? logicalAgentImages[handoff.toAgentId] : undefined;

  return (
    <div className="team-handoff" role="status" aria-live="polite">
      <span className="rail-node rail-node-agent team-handoff-node" aria-hidden="true">
        {to ? (
          <ProfileImage src={image} alt="" fallback={<IdentityMark kind="agent" />} />
        ) : (
          <ActionRoute size={ICON.xs} />
        )}
      </span>
      <span className="team-handoff-label">
        <ActionRoute size={ICON.xs} className="transcript-phase-icon" aria-hidden="true" />
        <span className="team-handoff-text">{label}</span>
        <span className="team-handoff-dots" aria-hidden="true"><i /><i /><i /></span>
      </span>
      {elapsed >= ELAPSED_AFTER_SECONDS ? (
        <span className="team-handoff-elapsed">{t("transcript.handoff_elapsed", { seconds: elapsed })}</span>
      ) : null}
    </div>
  );
}
