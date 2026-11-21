"use client";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkflowChoice } from "../../types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";

/** Shown once the reader chose to run a workflow (the drawer's Agent |
 *  Workflow switch), so it offers workflows only: running with Project Agents
 *  is the other side of that switch, not an item here. */
export function ProjectWorkflowSelect({ workflows, value, onChange, disabled, loading, failed, issue, onRetry, triggerId }: {
  workflows: ProjectWorkflowChoice[]; value: string; onChange: (id: string) => void; disabled?: boolean;
  loading?: boolean; failed?: boolean; issue?: boolean; onRetry: () => void; triggerId?: string;
}) {
  const { t } = useTranslation();
  const issueId = useId();
  const hintId = useId();
  const selected = workflows.find(workflow => workflow.id === value);
  const empty = !loading && !failed && !workflows.length;
  const describedBy = issue ? issueId : empty ? hintId : undefined;
  return <>
    <Select value={value || null} disabled={disabled || loading || failed || (empty && !value)} onValueChange={id => onChange(id ?? "")}>
      <SelectTrigger id={triggerId} className="w-full" aria-label={t("workflow.select_workflow")} aria-invalid={issue || undefined} aria-describedby={describedBy}>
        <SelectValue>{value ? selected?.name ?? t(loading ? "workflow.loading" : "workflow.unavailable") : t(loading ? "workflow.loading" : "workflow.choose")}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {workflows.map(workflow => <SelectItem key={workflow.id} value={workflow.id} disabled={!workflow.enabled}>{workflow.name}</SelectItem>)}
      </SelectContent>
    </Select>
    {failed ? <div role="alert"><p>{t("workflow.load_failed")}</p><Button type="button" variant="ghost" size="dense" onClick={onRetry}>{t("workspace.retry")}</Button></div>
      : issue && !loading ? <p id={issueId} role="alert" className="text-destructive">{t("workflow.unavailable_selection")}</p>
      : empty ? <p id={hintId} className="adm-form-hint">{t("workflow.none_in_project")}</p>
      : <p className="adm-form-hint">{t("workflow.optional_assignment_hint")}</p>}
  </>;
}
