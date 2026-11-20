"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatImportElapsed, skillImportStage } from "../lib/skillImportProgress";

export type SkillImportKind = "github" | "upload" | "reimport";

const TICK_MS = 1000;

/**
 * The wait for a skill publish or GitHub (re-)import. The request reports no
 * progress of its own, so the bar is indeterminate; what moves is the elapsed
 * clock and a status line that steps up as the wait grows (see
 * lib/skillImportProgress). Mount it only while the request is in flight:
 * the clock starts at mount.
 */
export function SkillImportProgress({ kind }: { kind: SkillImportKind }) {
  const { t } = useTranslation();
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = now - startedAt;
  const stage = skillImportStage(elapsed);
  const message = stage === "started"
    ? t(`skills.progress.started.${kind}`)
    : t(`skills.progress.${stage}`);
  return (
    <div className="skill-import-progress">
      <div
        className="skill-import-progress-bar"
        role="progressbar"
        aria-label={t("skills.progress.label")}
        aria-valuetext={t("skills.progress.elapsed", { time: formatImportElapsed(elapsed) })}
      />
      <div className="skill-import-progress-meta">
        {/* Only the message is live: it changes at most twice, where a live
            clock would be read aloud every second. */}
        <p role="status" aria-live="polite">{message}</p>
        <span className="skill-import-progress-clock" aria-hidden="true">
          {formatImportElapsed(elapsed)}
        </span>
      </div>
    </div>
  );
}
