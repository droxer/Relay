"use client";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectWorkflowChoice } from "../../types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";

export function ProjectWorkflowSelect({ workflows, value, onChange, disabled, loading, failed, issue, onRetry }: {
  workflows: ProjectWorkflowChoice[]; value: string; onChange: (id: string) => void; disabled?: boolean;
  loading?: boolean; failed?: boolean; issue?: boolean; onRetry: () => void;
}) {
  const { t } = useTranslation();
  const issueId = useId();
  const selected = workflows.find(workflow => workflow.id === value);
  return <>
    <Select value={value || "none"} disabled={disabled || loading || failed} onValueChange={id => onChange(id === "none" ? "" : id ?? "")}>
      <SelectTrigger className="w-full" aria-label={t("workflow.select_workflow")} aria-invalid={issue || undefined} aria-describedby={issue ? issueId : undefined}>
        <SelectValue>{value ? selected?.name ?? t(loading ? "workflow.loading" : "workflow.unavailable") : t("workflow.project_default_agents")}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{t("workflow.project_default_agents")}</SelectItem>
        {workflows.map(workflow => <SelectItem key={workflow.id} value={workflow.id} disabled={!workflow.enabled}>{workflow.name}</SelectItem>)}
      </SelectContent>
    </Select>
    {failed ? <div role="alert"><p>{t("workflow.load_failed")}</p><Button type="button" variant="ghost" size="dense" onClick={onRetry}>{t("workspace.retry")}</Button></div>
      : issue && !loading ? <p id={issueId} role="alert" className="text-destructive">{t("workflow.unavailable_selection")}</p> : null}
  </>;
}
