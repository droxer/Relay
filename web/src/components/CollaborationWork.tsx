"use client";

import { useTranslation } from "react-i18next";
import type { RelaySession, EmployeeAgent } from "../types";
import { deriveCollaborationWork } from "../lib/collaborationWork";

export function CollaborationWork({ session, agents }: { session?: RelaySession; agents: EmployeeAgent[] }) {
  const { t } = useTranslation();
  const items = deriveCollaborationWork(session);
  if (!items.length) return null;
  const name = (id: string) => agents.find(agent => agent.id === id)?.displayName ?? id;
  const workName = (id: string) => items.find(item => item.workItemId === id)?.objective ?? id;
  return <details className="handoff-panel">
    <summary className="cursor-pointer">{t("team_work.work")} · {items.filter(item => item.status === "accepted").length}/{items.length}</summary>
    <ol className="grid gap-4 py-3">
      {items.map(item => <li key={item.workItemId} className="grid gap-1">
        <div className="flex flex-wrap justify-between gap-2"><strong>{name(item.ownerAgentId)}</strong><span>{t(`team_work.status_${item.status}`)}</span></div>
        <p>{item.objective}</p>
        <span className="adm-form-hint">{item.required ? t("team_work.required") : t("team_work.optional")}</span>
        {item.dependsOnWorkItemIds.length ? <p className="adm-form-hint">{t("team_work.depends_on")}: {item.dependsOnWorkItemIds.map(workName).join("; ")}</p> : null}
        {item.acceptanceCriteria?.length ? <p>{t("team_work.criteria")}: {item.acceptanceCriteria.join("; ")}</p> : null}
        {item.expectedOutputs?.length ? <p>{t("team_work.outputs")}: {item.expectedOutputs.join("; ")}</p> : null}
        {item.result?.note ? <p>{item.result.note}</p> : null}
        {item.result?.evidence.map((entry, index) => <p key={`e-${index}`} className="adm-form-hint">{entry}</p>)}
        {item.result?.findings?.map((finding, index) => <p key={`f-${index}`}>{workName(finding.workItemId)}: {finding.note}</p>)}
        {item.messages.map((message, index) => <p key={`m-${index}`}><strong>{t(`team_work.message_${message.kind}`)}</strong>{message.toWorkItemId ? ` → ${workName(message.toWorkItemId)}` : ""}: {message.text}</p>)}
      </li>)}
    </ol>
  </details>;
}
