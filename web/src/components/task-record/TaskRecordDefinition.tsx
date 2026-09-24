"use client";

import { useTranslation } from "react-i18next";
import { Markdown } from "../LazyMarkdown";
import type { AgentTeam, RelayTaskListItem } from "../../types";
import { effectiveStyle } from "../../lib/collaborationStyle";
import type { RecordVariant } from "./recordVocabulary";

/**
 * What the record is, read-only.
 *
 * The band above already carries the spine a reader came in knowing — state,
 * cadence or status, next run or due, assignee, ref — and `RecordBand`'s
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
  team?: Pick<AgentTeam, "collaborationStyle">;
}) {
  const { t } = useTranslation();

  const rows: { key: string; label: string; value: string }[] = [
    {
      key: "priority",
      label: t("backlog.priority"),
      value: t(`backlog.priorities.${task.priority}`),
    },
    {
      key: "acceptance",
      label: t("backlog.acceptance_policy"),
      value: t(task.acceptancePolicy === "automatic" ? "backlog.acceptance_automatic" : "backlog.acceptance_human"),
    },
  ];
  if (variant === "routine") {
    // Routine settings use the same collaboration override as tasks.
    rows.unshift({
      key: "type",
      label: t("routine.type"),
      value: task.routineType ? t(`routine.types.${task.routineType}`) : "—",
    });
    rows.push({
      key: "enabled",
      label: t("routine.enabled"),
      value: t(task.routineEnabled ? "record.enabled_yes" : "record.enabled_no"),
    });
  }
  if (task.assignedTeamId) rows.push({
    key: "collaboration", label: t("collab_style.task_label"),
    value: task.collaborationStyle ? t(`collab_style.${effectiveStyle(team, task.collaborationStyle)}`)
      : t("collab_style.team_default", { style: t(`collab_style.${effectiveStyle(team)}`) }),
  });
  rows.push(
    { key: "created", label: t("record.created"), value: recordTimestamp(task.createdAt, locale) },
    { key: "updated", label: t("record.updated"), value: recordTimestamp(task.updatedAt, locale) },
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
            <div className="record-facts-row" key={row.key}>
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
