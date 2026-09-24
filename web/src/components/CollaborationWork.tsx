"use client";

import { useTranslation } from "react-i18next";
import type { RelaySession, EmployeeAgent, Tone } from "../types";
import { deriveCollaborationWork, type CollaborationWorkView } from "../lib/collaborationWork";
import { TonePill } from "./StatusPill";

/* The team's work graph for the active session, as a disclosure in the
   transcript. It draws the stream's own disclosure grammar (branch glyph, no
   native marker) rather than borrowing `.handoff-panel` — that class is the
   handoff routing drawer's shape, and <HandoffStatus> renders it one line
   above, so sharing it made two different meanings look identical. */

const STATUS_TONE: Record<CollaborationWorkView["status"], Tone> = {
  pending: "neutral",
  running: "info",
  stale: "warn",
  unverified: "warn",
  needs_changes: "warn",
  reported_done: "info",
  blocked: "bad",
};

const OUTCOME_TONE: Record<NonNullable<RelaySession["workOutcome"]>, Tone> = {
  reported_done: "info",
  unfinished: "warn",
  blocked: "bad",
  needs_review: "warn",
  unverified: "neutral",
  accepted: "good",
};

export function CollaborationWork({ session, agents }: { session?: RelaySession; agents: EmployeeAgent[] }) {
  const { t } = useTranslation();
  const items = deriveCollaborationWork(session);
  const outcome = session?.workOutcome ?? (session?.status === "completed" ? "unverified" : undefined);
  if (!items.length && !outcome) return null;
  const name = (id: string) => agents.find((agent) => agent.id === id)?.displayName ?? id;
  const workName = (id: string) => items.find((item) => item.workItemId === id)?.objective ?? id;
  const reported = items.filter((item) => item.status === "reported_done").length;

  return (
    <>
      {outcome ? (
        <div className="team-work-panel" role="status">
          <TonePill tone={OUTCOME_TONE[outcome]} label={t(`team_work.outcome_${outcome}`)} />
          {session?.finalOutcome ? <p className="team-work-detail">{session.finalOutcome}</p> : null}
        </div>
      ) : null}
      {items.length ? <details className="team-work-panel">
        <summary>
          <span className="collaboration-branch" aria-hidden="true" />
          <span className="team-work-panel-title">{t("team_work.work")}</span>
          <span className="team-work-panel-count">{reported}/{items.length}</span>
        </summary>
        <ol className="team-work-items">
          {items.map((item) => (
            <li className="team-work-entry" key={item.workItemId}>
              <div className="team-work-entry-head">
                <span className="team-work-entry-owner">{name(item.ownerAgentId)}</span>
                <TonePill
                  tone={STATUS_TONE[item.status]}
                  label={t(`team_work.status_${item.status}`)}
                  live={item.status === "running"}
                />
              </div>
              <p className="team-work-entry-objective">{item.objective}</p>
              <p className="team-work-detail">
                {item.required ? t("team_work.required") : t("team_work.optional")}
              </p>
              {item.dependsOnWorkItemIds.length ? (
                <p className="team-work-detail">
                  <span className="team-work-detail-kind">{t("team_work.depends_on")}</span>: {item.dependsOnWorkItemIds.map(workName).join("; ")}
                </p>
              ) : null}
              {item.acceptanceCriteria?.length ? (
                <p className="team-work-detail"><span className="team-work-detail-kind">{t("team_work.criteria")}</span>: {item.acceptanceCriteria.join("; ")}</p>
              ) : null}
              {item.expectedOutputs?.length ? (
                <p className="team-work-detail"><span className="team-work-detail-kind">{t("team_work.outputs")}</span>: {item.expectedOutputs.join("; ")}</p>
              ) : null}
              {item.result?.note ? <p className="team-work-detail">{item.result.note}</p> : null}
              {(item.result?.evidence ?? []).map((entry, index) => (
                <p className="team-work-detail team-work-detail--quiet" key={`e-${index}`}>{entry}</p>
              ))}
              {/* Same grammar as a message row: the bold kind, the work item it
                  is aimed at, then the text. Written flat, a finding read as a
                  sentence whose left half looked like a label. */}
              {item.result?.findings?.map((finding, index) => (
                <p className="team-work-detail" key={`f-${index}`}>
                  <span className="team-work-detail-kind">{t("team_work.finding")}</span>
                  {` → ${workName(finding.workItemId)}`}: {finding.note}
                </p>
              ))}
              {item.messages.map((message, index) => (
                <p className="team-work-detail" key={`m-${index}`}>
                  <span className="team-work-detail-kind">{t(`team_work.message_${message.kind}`)}</span>
                  {message.toWorkItemId ? ` → ${workName(message.toWorkItemId)}` : ""}: {message.text}
                </p>
              ))}
            </li>
          ))}
        </ol>
      </details> : null}
    </>
  );
}
