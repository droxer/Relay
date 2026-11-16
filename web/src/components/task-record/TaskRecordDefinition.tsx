"use client";

import { useTranslation } from "react-i18next";
import { Markdown } from "../LazyMarkdown";
import type { AgentTeam, RelayTaskListItem } from "../../types";
import { defaultWorkflowId, predefinedStyle } from "../../lib/workflowSelection";
import { isWorkflowTeam } from "../../lib/workflowTeamDraft";
import { taskAcceptancePolicy } from "../../lib/taskBoardForm";
import { TaskTagList } from "../TaskTags";
import type { ReactNode } from "react";
import type { RecordVariant } from "./recordVocabulary";

/**
 * What the record is, read-only.
 *
 * The band above already carries the spine a reader came in knowing — state,
 * cadence or status, next run or due, assignee, issue ID — and `RecordBand`'s
 * contract forbids restating any of it here. So this panel holds exactly what
 * the band cannot: the description as a document, and the settings that
 * govern a run without describing when it happens.
 *
 * Editing lives in the drawer, reached from the header. A record surface that
 * is half form is the thing this redesign removed.
 */
export function TaskRecordDefinition({
  task,
  variant,
  locale,
  team,
}: {
  task: RelayTaskListItem;
  variant: RecordVariant;
  locale: string;
  team?: Pick<AgentTeam, "collaborationStyle" | "workflowSteps" | "workflows" | "defaultWorkflowId">;
}) {
  const { t } = useTranslation();

  const rows: { key: string; label: string; value: ReactNode; meta?: boolean }[] = [
    {
      key: "priority",
      label: t("backlog.priority"),
      value: t(`backlog.priorities.${task.priority}`),
    },
    {
      key: "tags",
      label: t("tags.label"),
      value: task.tags?.length ? <TaskTagList tags={task.tags} /> : t("tags.none"),
    },
    {
      key: "acceptance",
      label: t("backlog.acceptance_policy"),
      value: t(taskAcceptancePolicy(task) === "automatic" ? "backlog.acceptance_automatic" : "backlog.acceptance_human"),
    },
  ];
  if (variant === "routine") {
    // Routine settings use the same collaboration override as tasks.
    rows.push({
      key: "enabled",
      label: t("routine.enabled"),
      value: t(task.routineState === "active" ? "record.enabled_yes" : "record.enabled_no"),
    });
  }
  const selectedId = task.assignedWorkflowId
    ?? (task.collaborationStyle ? `preset:${task.collaborationStyle === "solo" ? "build_review" : task.collaborationStyle}` : team?.defaultWorkflowId ?? (team?.collaborationStyle ? `preset:${team.collaborationStyle === "solo" ? "build_review" : team.collaborationStyle}` : undefined));
  const workflow = team?.workflows?.find(item => item.id === selectedId);
  if (task.assignedTeamId && !(team && isWorkflowTeam(team) && !selectedId)) {
    const style = predefinedStyle(selectedId ?? defaultWorkflowId());
    const name = style ? t(`collab_style.${style}`) : workflow?.name ?? t("workflow.unavailable");
    rows.push({ key: "workflow", label: t("workflow.select_workflow"),
      value: task.assignedWorkflowId || task.collaborationStyle ? name : t("workflow.inherit_default", { name }) });
  } else if (team && isWorkflowTeam(team)) rows.push({
    key: "workflow", label: t("workflow.section_title"),
    value: t("workflow.step_count", { count: team.workflowSteps?.length ?? 0 }),
  });
  rows.push(
    { key: "created", label: t("record.created"), value: recordTimestamp(task.createdAt, locale), meta: true },
    { key: "updated", label: t("record.updated"), value: recordTimestamp(task.updatedAt, locale), meta: true },
  );

  return (
    <div className="record-definition">
      <section className="record-definition-doc" aria-label={t("backlog.description")}>
        <h3 className="record-section-title">{t("backlog.description")}</h3>
        {task.description.trim() ? (
          <Markdown variant="document" text={task.description} />
        ) : (
          <p className="record-empty">{t("record.no_description")}</p>
        )}
      </section>
      <section className="record-definition-facts" aria-label={t("record.tab_definition")}>
        <h3 className="record-section-title">{t("record.settings")}</h3>
        <dl className="record-facts">
          {rows.map((row) => (
            <div className={row.meta ? "record-facts-row record-facts-row--meta" : "record-facts-row"} key={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function recordTimestamp(value: string | undefined, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale || undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
