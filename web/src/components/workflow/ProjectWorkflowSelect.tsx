"use client";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { projectWorkflowName, type ProjectWorkflowIssue, type ProjectWorkflowOption } from "../../lib/workflowSelection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import { PredefinedWorkflowIcon } from "./PredefinedWorkflowIcon";

export function ProjectWorkflowOptionLabel({ option }: { option: ProjectWorkflowOption }) {
  const { t } = useTranslation();
  return <span className="flex flex-wrap items-center gap-2">
    {option.kind === "predefined" ? <PredefinedWorkflowIcon style={option.template} /> : null}
    <span>{projectWorkflowName(option.id, t, option.kind === "steps" ? option.name : undefined)}</span>
    <span className="text-muted-foreground">{t(option.kind === "predefined" ? "workflow.predefined" : "workflow.custom")}</span>
    {option.issue ? <span className="text-muted-foreground">{t(`workflow.${option.issue}`)}</span> : null}
  </span>;
}

/** Shown once the reader chose to run a workflow (the drawer's Agent |
 *  Workflow switch), so it offers workflows only: running with Project Agents
 *  is the other side of that switch, not an item here. */
export function ProjectWorkflowSelect({ workflows, value, onChange, disabled, loading, failed, issue, onRetry, triggerId }: {
  workflows: ProjectWorkflowOption[]; value: string; onChange: (id: string) => void; disabled?: boolean;
  loading?: boolean; failed?: boolean; issue?: ProjectWorkflowIssue | null; onRetry: () => void; triggerId?: string;
}) {
  const { t } = useTranslation();
  const issueId = useId();
  const selected = workflows.find(workflow => workflow.id === value);
  const showIssue = issue && (issue !== "unavailable_selection" || !loading);
  return <>
    <Select value={value || null} disabled={disabled} onValueChange={id => onChange(id ?? "")}>
      <SelectTrigger id={triggerId} className="w-full" aria-label={t("workflow.select_workflow")} aria-invalid={Boolean(issue) || undefined} aria-describedby={showIssue ? issueId : undefined}>
        <SelectValue>{value ? projectWorkflowName(value, t, selected?.kind === "steps" ? selected.name : undefined)
          ?? t(loading ? "workflow.loading" : "workflow.unavailable") : t("workflow.choose")}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {workflows.map(workflow => <SelectItem key={workflow.id} value={workflow.id} disabled={Boolean(workflow.issue)}>
          <ProjectWorkflowOptionLabel option={workflow} />
        </SelectItem>)}
      </SelectContent>
    </Select>
    {failed ? <div role="alert"><p>{t("workflow.load_failed")}</p><Button type="button" variant="ghost" size="dense" onClick={onRetry}>{t("workspace.retry")}</Button></div> : null}
    {showIssue ? <p id={issueId} role="alert" className="text-destructive">{t(`workflow.${issue}`)}</p>
      : <p className="adm-form-hint">{t("workflow.optional_assignment_hint")}</p>}
  </>;
}
