"use client";
import { ThreadPrompt } from "./ThreadPrompt";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { applyManagerProposal, dismissManagerProposal } from "../api-client/project-manager";
import type { ManagerFields, ManagerProposal } from "../domain-types/project-manager";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { navigateToAppPath } from "../lib/appRoute";

export function ManagerProposalCard({ projectId, proposal, disabled, onChanged, agents = [], teams = [] }: {
  projectId: string; proposal: ManagerProposal; disabled: boolean; onChanged: () => void;
  agents?: Array<{id: string; displayName: string}>; teams?: Array<{id: string; displayName: string}>;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(proposal.operations.map(op => op.id));
  const [edits, setEdits] = useState<Record<string, ManagerFields>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const application = useRef<{ fingerprint: string; key: string } | null>(null);
  const edit = (id: string, fields: ManagerFields) => setEdits(old => ({ ...old, [id]: fields }));
  const pending = proposal.state === "pending";
  const beforeValue = (name: string, value: unknown) => {
    if (value == null || value === "") return t("project_manager.none");
    if (name === "assignedAgentId" || name === "assignedTeamId") return (name === "assignedAgentId" ? agents : teams).find(a => a.id === value)?.displayName ?? t("project_manager.agent_unavailable");
    if (name === "priority") return t(`backlog.priorities.${String(value)}`);
    return Array.isArray(value) ? value.join(", ") : String(value);
  };
  async function apply() {
    const fields = Object.fromEntries(Object.entries(edits).filter(([id]) => selected.includes(id)));
    const fingerprint = JSON.stringify({ selected, fields });
    if (application.current?.fingerprint !== fingerprint) application.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      await applyManagerProposal(projectId, proposal.id, { operationIds: selected, fields,
        expectedRevision: proposal.revision, idempotencyKey: application.current!.key });
      onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function dismiss() {
    setBusy(true); setError("");
    try { await dismissManagerProposal(projectId, proposal.id); onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <ThreadPrompt title={t("project_manager.changes")}><section className="manager-proposal" aria-label={t("project_manager.changes")}>
    <h3>{t("project_manager.changes")}</h3>
    <p role="status">{t(`project_manager.proposal_${proposal.state}`)}</p>
    {proposal.operations.map(op => {
      const fields = edits[op.id] ?? op.fields;
      const label = op.title || fields.title || op.taskId || op.key || op.id;
      return <fieldset key={op.id} disabled={!pending || disabled || busy} className="manager-operation">
        <legend><label><input type="checkbox" checked={selected.includes(op.id)} onChange={event => setSelected(old => event.target.checked ? [...old, op.id] : old.filter(id => id !== op.id))} /> {label}</label></legend>
        {op.taskId ? <a href={`/projects/${encodeURIComponent(projectId)}?task=${encodeURIComponent(op.taskId)}`} onClick={event => {
          if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); void navigateToAppPath(event.currentTarget.getAttribute("href")!);
        }}>{t("project_manager.open_task")}</a> : null}
        {Object.entries(fields).map(([name, value]) => {
          const id = `${proposal.id}-${op.id}-${name}`;
          return <div key={name} className="manager-field">
            <label htmlFor={id}>{t(`project_manager.field_${name}`)}</label>
            {op.before && name in op.before ? <p className="manager-before">{t("project_manager.before", { value: beforeValue(name, op.before[name as keyof ManagerFields]) })}</p> : null}
            {name === "description" ? <Textarea id={id} value={String(value ?? "")} onChange={e => edit(op.id, { ...fields, description: e.target.value })} /> :
              name === "priority" ? <select id={id} value={String(value)} onChange={e => edit(op.id, { ...fields, priority: e.target.value })}>{["low", "normal", "high"].map(priority => <option key={priority} value={priority}>{t(`backlog.priorities.${priority}`, {defaultValue:priority})}</option>)}</select> :
              name === "assignedAgentId" || name === "assignedTeamId" ? <select id={id} value={String(value ?? "")} onChange={e => edit(op.id, {...fields,[name]:e.target.value || null})}>
                <option value="">{t("project_manager.none")}</option>
                {(name === "assignedAgentId" ? agents : teams).map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}
                {value && !(name === "assignedAgentId" ? agents : teams).some(a => a.id === value) ? <option value={String(value)}>{t("project_manager.agent_unavailable")}</option> : null}
              </select> :
              <Input id={id} type={name === "dueDate" ? "date" : "text"} value={Array.isArray(value) ? value.join(", ") : String(value ?? "")} onChange={e => edit(op.id, { ...fields, [name]: name === "tags" ? e.target.value.split(",").map(s => s.trim()).filter(Boolean) : (e.target.value || (name === "title" ? "" : null)) })} />}
          </div>;
        })}
        {op.after.length || op.afterTaskIds.length || op.kind === "prerequisites" ? <p>{t("project_manager.after", { value: [...op.after, ...op.afterTaskIds].join(", ") || t("project_manager.none") })}</p> : null}
      </fieldset>;
    })}
    {error ? <p role="alert">{error}</p> : null}
    {pending ? <div className="manager-actions"><Button disabled={disabled || busy || selected.length === 0} onClick={() => void apply()}>{t("project_manager.apply")}</Button><Button variant="ghost" disabled={disabled || busy} onClick={() => void dismiss()}>{t("project_manager.dismiss")}</Button></div> : null}
  </section></ThreadPrompt>;
}
