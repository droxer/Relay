import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonNodeMonitorRecord } from "../types";
import { computerName } from "../lib/computerNodes";
import { hrefForRoute, navigateToAppPath } from "../lib/appRoute";
import { queueWaitLabel, type QueuedRun } from "../lib/queuedRun";
import { StateMark } from "./StateMark";
import { Button, buttonVariants } from "@/components/ui/button";

const TICK_MS = 1_000;

/** The run's path, with this card standing on the middle step. */
const STEPS = ["sent", "queued", "running"] as const;

/**
 * A run that is admitted and waiting for a computer to take it.
 *
 * It sits in the transcript where the reply will stream, so the wait reads as
 * the turn's first state rather than a warning about the thread: the same
 * place, then the answer. It replaces the "Starting on…" line, whose live
 * pulse claimed an agent was at work, and the attention banner over the
 * transcript, which made the normal course of a busy computer look like a
 * fault. The wait counts up because "how long" is the question a queue
 * raises; the cause says whether waiting will end on its own.
 */
export function QueuedRunCard({ queued, node, onCancel }: {
  queued: QueuedRun;
  node: DaemonNodeMonitorRecord | null;
  /** Withdraw the run from the queue; absent where the reader cannot stop it. */
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const computer = (node && computerName(node)) || t("thread.queue_this_computer");
  const waited = queueWaitLabel(queued.queuedAt, now, "second");
  const offline = queued.cause === "offline";
  const computersHref = hrefForRoute("computers");

  return (
    <section className="queued-run" data-cause={queued.cause} aria-label={t("thread.execution_queued")}>
      <header className="queued-run-head">
        <StateMark tone={offline ? "warn" : "neutral"} shape="dashed" />
        <strong className="queued-run-label">{t("thread.execution_queued")}</strong>
        {/* Visual only: a counter inside a live region would be announced
            every second. The status sentence below carries the meaning. */}
        {waited ? <span className="queued-run-wait tnum" aria-hidden="true">{waited}</span> : null}
      </header>
      <ol className="queued-run-steps" aria-label={t("thread.queue_steps_label")}>
        {STEPS.map((step) => (
          <li key={step} className="queued-run-step" data-step={step} aria-current={step === "queued" ? "step" : undefined}>
            <span className="queued-run-dot" aria-hidden="true" />
            {t(`thread.queue_step_${step}`)}
          </li>
        ))}
      </ol>
      <p className="queued-run-cause" role="status">
        {t(offline ? "thread.queue_cause_offline" : "thread.queue_cause_slot", { computer })}
      </p>
      <div className="queued-run-actions">
        {onCancel ? (
          <Button type="button" variant="outline" size="dense" onClick={onCancel}>
            {t("thread.queue_cancel")}
          </Button>
        ) : null}
        {offline ? (
          <a
            data-slot="link-button"
            className={buttonVariants({ variant: "ghost", size: "dense" })}
            href={computersHref}
            onClick={(event) => {
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              void navigateToAppPath(computersHref);
            }}
          >
            {t("recovery.computer")}
          </a>
        ) : null}
      </div>
    </section>
  );
}
