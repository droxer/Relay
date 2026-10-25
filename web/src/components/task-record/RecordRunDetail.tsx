"use client";

import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { buttonVariants } from "@/components/ui/button";
import { pathForAppState } from "../../lib/appRoute";
import { runTriggerLabel } from "../../lib/automationTrigger";
import { formatRunDuration, runDurationMs, runOutcome, type RunOutcome } from "../../lib/taskRuns";
import type { TaskRun } from "../../types";
import { StateMark, type StateTone } from "../StateMark";
import { runDate, runTime } from "./runDates";

/** Outcome → the tone half of the state vocabulary; `StateMark` picks the shape. */
export const TONE_FOR_OUTCOME: Record<RunOutcome, StateTone> = {
  done: "good",
  failed: "bad",
  running: "live",
  pending: "neutral",
};

function isPlainClick(event: MouseEvent): boolean {
  return !(event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey);
}

/** A wayfinding anchor in the link-button grammar (see ExecutionRecoveryPanel):
 *  a real href, in-app navigation on a plain click. */
function RunLink({ href, onNavigate, children }: { href: string; onNavigate: () => void; children: ReactNode }) {
  return (
    <a
      data-slot="link-button"
      className={buttonVariants({ variant: "ghost", size: "dense" })}
      href={href}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onNavigate();
      }}
    >
      {children}
    </a>
  );
}

/**
 * The selected run, said in full above its folder.
 *
 * The ledger row has room for a date and a word; this is where the run is
 * read: what happened, when, how long it took, what fired it, and — for a
 * failure — the whole reason, unclipped. It also carries the two ways out of
 * the tab, the run's thread and its own record, so each ledger row can stay a
 * single select target.
 */
export function RecordRunDetail({
  run,
  runHref,
  onOpenRun,
  onOpenThread,
}: {
  run: TaskRun;
  runHref: string;
  onOpenRun: () => void;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const outcome = runOutcome(run);
  const duration = runDurationMs(run);
  const started = [runDate(run.scheduledFor ?? run.createdAt, i18n.language), runTime(run.startedAt ?? run.createdAt, i18n.language)]
    .filter(Boolean)
    .join(" · ");
  const trigger = runTriggerLabel(run, t);
  const threadId = run.latestSessionId;

  const facts = [
    { key: "started", label: t("backlog.runs.col_started"), value: started },
    { key: "duration", label: t("backlog.runs.col_duration"), value: duration === null ? "—" : formatRunDuration(duration) },
    ...(trigger ? [{ key: "trigger", label: t("backlog.runs.col_trigger"), value: trigger }] : []),
    {
      key: "files",
      label: t("backlog.runs.col_files"),
      value: run.artifactCount > 0 ? t("backlog.runs.files", { count: run.artifactCount }) : t("backlog.runs.files_none"),
    },
  ];

  return (
    <header className="record-run-detail" data-outcome={outcome} aria-label={t("backlog.runs.detail_label")}>
      <div className="record-run-detail-head">
        <StateMark tone={TONE_FOR_OUTCOME[outcome]} shape={outcome === "pending" ? "dashed" : undefined} />
        <h3 className="record-run-detail-title">{t(`backlog.runs.outcome.${outcome}`)}</h3>
        <div className="record-run-detail-actions">
          {threadId && onOpenThread ? (
            <RunLink
              href={pathForAppState({ route: "main", mobileView: "chat", sessionId: threadId })}
              onNavigate={() => onOpenThread(threadId)}
            >
              {t("backlog.open_thread")}
            </RunLink>
          ) : null}
          <RunLink href={runHref} onNavigate={onOpenRun}>{t("record.open_run")}</RunLink>
        </div>
      </div>
      <dl className="record-run-detail-facts">
        {facts.map((fact) => (
          <div key={fact.key} className="record-run-detail-fact">
            <dt>{fact.label}</dt>
            <dd className="tnum">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {/* The whole reason, unclipped: the ledger row only has room for its first line. */}
      {run.failureMessage ? <p className="record-run-detail-failure">{run.failureMessage}</p> : null}
    </header>
  );
}
