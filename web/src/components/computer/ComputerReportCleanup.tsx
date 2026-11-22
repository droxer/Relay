"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReportCleanupScope, ReportCleanupSnapshot } from "relay-core";
import { requestReportCleanup } from "../../api";
import { useKeyChange } from "../../hooks/useKeyChange";
import { Button } from "../ui/button";
import { useDialogs } from "../ui/DialogProvider";

type Counts = Pick<ReportCleanupSnapshot, "pending" | "quarantined">;

export function ComputerReportCleanup({ nodeId, name, pending, quarantined, available, supported }: Counts & {
  nodeId: string; name: string; available: boolean; supported: boolean;
}) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const request = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<"reading" | "confirming" | "clearing">();
  const [feedback, setFeedback] = useState("");
  const observed = `${pending}:${quarantined}`;
  const [local, setLocal] = useState<{ observed: string; counts: Counts }>();
  const counts = local?.observed === observed ? local.counts : { pending, quarantined };
  useEffect(() => () => request.current?.abort(), []);
  useKeyChange(observed, current => {
    setLocal(snapshot => snapshot?.observed === current ? snapshot : undefined);
  });

  async function clear(scope: ReportCleanupScope) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setFeedback("");
    let clearing = false;
    try {
      setPhase("reading");
      const preview = await requestReportCleanup(nodeId, { action: "preview" }, controller.signal);
      if (preview.outcome !== "ready") {
        setFeedback(t("computer.report_cleanup_read_failed"));
        return;
      }
      setLocal({ observed, counts: preview });
      const count = scope === "all" ? preview.pending : preview.quarantined;
      if (count === 0) {
        setFeedback(t("computer.report_cleanup_empty"));
        return;
      }
      setPhase("confirming");
      const confirmed = await confirm({
        title: t("computer.report_cleanup_confirm_title"),
        message: t(`computer.report_cleanup_confirm_${scope}`, { name, count }),
        confirmLabel: t(`computer.report_cleanup_${scope}`),
        tone: "danger",
      });
      if (!confirmed || controller.signal.aborted) return;
      clearing = true;
      setPhase("clearing");
      const result = await requestReportCleanup(nodeId, {
        action: "discard", scope, revision: preview.revision, acknowledgeOutputLoss: true,
      }, controller.signal);
      setLocal({ observed, counts: result });
      setFeedback(result.outcome === "discarded"
        ? t("computer.report_cleanup_done", { count: result.discarded })
        : t(`computer.report_cleanup_${result.outcome === "busy" || result.outcome === "changed" ? result.outcome : "failed"}`));
    } catch {
      if (!controller.signal.aborted) setFeedback(t(clearing ? "computer.report_cleanup_failed" : "computer.report_cleanup_read_failed"));
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setPhase(undefined);
    }
  }

  if (!counts.pending && !counts.quarantined && !feedback && !phase) return null;
  const disabled = !available || !supported || !!phase;
  const status = phase === "reading" || phase === "clearing" ? t(`computer.report_cleanup_${phase}`) : feedback;
  return (
    <section className="computer-card-section">
      <div className="computer-card-section-head">
        <h3 className="computer-card-section-title">{t("computer.report_cleanup_heading")}</h3>
        <span className="computer-card-connection-count tnum">
          {t("computer.report_cleanup_counts", { total: counts.pending, quarantined: counts.quarantined })}
        </span>
      </div>
      {supported && counts.pending > 0 ? (
        <div className="computer-card-section-actions">
          {counts.quarantined > 0 ? (
            <Button type="button" size="dense" variant="outline" disabled={disabled} onClick={() => { void clear("quarantined"); }}>
              {t("computer.report_cleanup_quarantined")}
            </Button>
          ) : null}
          <Button type="button" size="dense" variant="outline" disabled={disabled} onClick={() => { void clear("all"); }}>
            {t("computer.report_cleanup_all")}
          </Button>
        </div>
      ) : null}
      {!supported || (!available && counts.pending > 0) ? (
        <p className="computer-card-idle">{t(supported ? "computer.report_cleanup_offline" : "computer.report_cleanup_upgrade")}</p>
      ) : null}
      <span className={status ? "computer-card-idle" : "sr-only"} role="status">{status}</span>
    </section>
  );
}
