"use client";

import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { AgentTeam } from "../../types";
import { defaultWorkflowId, predefinedStyle, teamWorkflowName, workflowOptions, workflowSelectionIssue, workflowParticipantsAllowed } from "../../lib/workflowSelection";
import { PredefinedWorkflowIcon } from "./PredefinedWorkflowIcon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

/** A Workflow's display name: a predefined one's localized name, else the
 *  Team's custom definition, else "unavailable" for one no longer offered. */
export function useWorkflowName(team?: Pick<AgentTeam, "workflows" | "workflowOptions">): (workflowId: string) => string {
  const { t } = useTranslation();
  return (workflowId) => {
    const style = predefinedStyle(workflowId);
    if (style) return t(`collab_style.${style}`);
    return teamWorkflowName(team, workflowId) ?? t("workflow.unavailable");
  };
}

/** One selection contract for predefined role processes and custom steps. */
export function WorkflowSelect({ team, value, onChange, inherit = false, predefinedOnly = false, projectId, projectAgentIds, restrictToProject = Boolean(projectId), disabled, compact, id, "aria-label": label }: {
  team?: AgentTeam;
  value: string | null;
  onChange: (value: string | null) => void;
  inherit?: boolean;
  predefinedOnly?: boolean;
  projectId?: string;
  projectAgentIds?: readonly string[];
  restrictToProject?: boolean;
  disabled?: boolean;
  compact?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const { t } = useTranslation();
  const options = workflowOptions(team, projectId).filter(option => (!predefinedOnly || option.kind === "predefined")
    && (!projectAgentIds || workflowParticipantsAllowed(team, option.id, projectAgentIds)));
  const nameOf = useWorkflowName(team);
  const inheritedName = nameOf(defaultWorkflowId(team, projectId));
  const selected = value ?? (inherit ? "inherit" : defaultWorkflowId(team, projectId));
  const inheritedIssue = restrictToProject ? workflowSelectionIssue(team, null, projectId, projectAgentIds) : null;
  const issue = restrictToProject ? workflowSelectionIssue(team, value, projectId, projectAgentIds) : null;
  const issueId = useId();
  return <><Select value={selected} disabled={disabled} onValueChange={next => {
    if (next === "inherit") onChange(null);
    else if (next && options.some(option => option.id === next)) onChange(next);
  }}>
    <SelectTrigger id={id} size={compact ? "sm" : "default"} aria-label={label ?? t("workflow.select_workflow")}
      aria-invalid={Boolean(issue) || undefined} aria-describedby={issue ? issueId : undefined}
      className={compact ? "w-auto max-w-full" : "w-full"}>
      <SelectValue>{selected === "inherit" ? t("workflow.inherit_default", { name: inheritedName }) : nameOf(selected)}</SelectValue>
    </SelectTrigger>
    <SelectContent align="start" alignItemWithTrigger={false}>
      {inherit ? <SelectItem value="inherit" disabled={Boolean(inheritedIssue)}>{t("workflow.inherit_default", { name: inheritedName })}</SelectItem> : null}
      {options.map(option => <SelectItem key={option.id} value={option.id} disabled={!option.enabled}>
        <span className="flex items-center gap-2">
          {option.template ? <PredefinedWorkflowIcon style={option.template} /> : null}
          <span>{nameOf(option.id)}</span>
          <span className="text-muted-foreground">{t(option.kind === "predefined" ? "workflow.predefined" : "workflow.custom")}</span>
        </span>
      </SelectItem>)}
      {value && !options.some(option => option.id === value) ? <SelectItem value={value} disabled>{nameOf(value)}</SelectItem> : null}
    </SelectContent>
  </Select>{issue ? <p id={issueId} role="alert" className="text-destructive">{t(issue === "project" ? "workflow.incompatible_project" : "workflow.unavailable_selection")}</p> : null}</>;
}
