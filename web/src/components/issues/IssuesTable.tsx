"use client";

import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortColumnButton } from "@/components/ui/SortableColumnHeader";
import { PriorityBadge } from "../PriorityBadge";
import { StateMark } from "../StateMark";
import { TaskAssignee } from "../TaskAssignee";
import { TaskSelectCheckbox } from "../task-board/TaskSelection";
import { TASK_STATUS_SHAPE } from "../task-board/backlogVocabulary";
import { formatDueDate } from "../task-board/BacklogChrome";
import { hrefForTaskRecord } from "../task-board/BacklogRecords";
import { dueTone } from "../../lib/backlog";
import { sortIndicator, type SortState } from "../../lib/listSort";
import { issueNeedsProject, NO_GROUP, type IssueGroup, type IssueGroupBy, type IssueSortKey } from "../../lib/issueQueues";
import { taskRef } from "../../lib/taskRef";
import type { RelayTaskListItem, TaskStatus } from "../../types";

/** What a row needs beyond the task itself, resolved by the page per record. */
export interface IssueRowContext {
  projectName?: string;
  ready: boolean;
  agentDisplayName?: string;
  agentImageUrl?: string | null;
}

/**
 * The Issues table: one header, then one `<tbody>` per band.
 *
 * It is a full table, not the project board's lean list, because it is read
 * across projects: the project and the status are columns here. Whichever of
 * them the page groups by moves into the band instead — a row under a band
 * that says "Blocked" has already said it, so the column would only repeat it.
 *
 * Plain markup rather than TanStack: bands are row groups, which a flat row
 * model does not express, and sorting is already the page's (URL-backed).
 */
export function IssuesTable({
  groups,
  groupBy,
  groupTotals,
  sort,
  onSort,
  selectAll,
  selectedIds,
  onToggleSelect,
  contextFor,
  onOpenIssue,
}: {
  /** The current page, banded. */
  groups: IssueGroup[];
  groupBy: IssueGroupBy;
  /** Each band's WHOLE size across pages — what a band reports. */
  groupTotals: ReadonlyMap<string, number>;
  sort: SortState<IssueSortKey> | null;
  onSort: (key: IssueSortKey) => void;
  selectAll: ReactNode;
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (taskId: string) => void;
  contextFor: (task: RelayTaskListItem) => IssueRowContext;
  onOpenIssue: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const showStatus = groupBy !== "status";
  const showProject = groupBy !== "project";
  const columnCount = 6 + Number(showStatus) + Number(showProject);

  function head(key: IssueSortKey, label: string, className?: string): ReactNode {
    const { active, direction, ariaSort } = sortIndicator(sort, key);
    return (
      <TableHead className={className} aria-sort={sort?.key === key ? ariaSort : undefined}>
        <SortColumnButton label={label} sortKey={key} onSort={onSort} align="start" active={active} direction={direction} />
      </TableHead>
    );
  }

  function bandLabel(group: IssueGroup): string {
    if (groupBy === "status") return t(`backlog.statuses.${group.key as TaskStatus}`);
    if (group.key !== NO_GROUP) return group.label;
    return groupBy === "project" ? t("issues.no_project") : groupBy === "assignee" ? t("issues.unassigned") : t("issues.all");
  }

  function openIssue(event: MouseEvent<HTMLAnchorElement>, taskId: string): void {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onOpenIssue(taskId);
  }

  return (
    <Table aria-label={t("issues.title")} className="issues-table">
      <TableHeader>
        <TableRow className="backlog-rows-head hover:bg-transparent">
          <TableHead className="w-4">{selectAll}</TableHead>
          <TableHead className="task-col-ref">{t("backlog.col_ref")}</TableHead>
          {head("title", t("issues.col_issue"))}
          {showStatus ? head("status", t("backlog.status"), "issue-col-status") : null}
          {showProject ? head("project", t("issues.col_project"), "issue-col-project") : null}
          {head("priority", t("backlog.priority"), "task-col-priority")}
          {head("assignee", t("backlog.assignee"), "task-col-assignee")}
          {head("due", t("backlog.due"), "task-col-due")}
        </TableRow>
      </TableHeader>
      {groups.map((group) => (
        <TableBody key={group.key} className="issues-group" aria-label={groupBy === "none" ? undefined : bandLabel(group)}>
          {groupBy === "none" ? null : (
            <TableRow className="issues-band hover:bg-transparent" data-status={groupBy === "status" ? group.key : undefined}
              data-intake={groupBy === "project" && group.key === NO_GROUP ? "true" : undefined}>
              <TableCell colSpan={columnCount}>
                <span className="issues-band-inner">
                  {groupBy === "status" ? <StateMark shape={TASK_STATUS_SHAPE[group.key as TaskStatus]} /> : null}
                  <span className="list-group-name">{bandLabel(group)}</span>
                  <span className="list-group-count tnum">{groupTotals.get(group.key) ?? group.tasks.length}</span>
                  {groupBy === "project" && group.key === NO_GROUP ? (
                    <span className="issues-band-hint">{t("issues.intake_hint")}</span>
                  ) : null}
                </span>
              </TableCell>
            </TableRow>
          )}
          {group.tasks.map((task) => {
            const context = contextFor(task);
            const tone = dueTone(task);
            const intake = issueNeedsProject(task);
            return (
              <TableRow
                key={task.id}
                className="backlog-row group"
                data-status={task.status}
                data-priority={task.priority}
                data-selected={selectedIds.has(task.id) ? "true" : undefined}
              >
                <TableCell className="w-4">
                  <TaskSelectCheckbox
                    className="backlog-select-box"
                    checked={selectedIds.has(task.id)}
                    label={t("backlog.select_task", { title: task.title })}
                    onCheckedChange={() => onToggleSelect(task.id)}
                  />
                </TableCell>
                <TableCell className="task-col-ref backlog-row-ref">{taskRef(task.id)}</TableCell>
                <TableCell className="max-w-md whitespace-normal">
                  <div className="backlog-row-lead-main">
                    <a className="backlog-row-title" href={hrefForTaskRecord(task.id)} onClick={(event) => openIssue(event, task.id)}>
                      {task.title}
                    </a>
                    {intake && task.status !== "done" ? <Badge variant="warning" className="issue-intake-chip">{t("issues.needs_project")}</Badge> : null}
                  </div>
                </TableCell>
                {showStatus ? (
                  <TableCell className="issue-col-status">
                    <span className="issue-status">
                      <StateMark shape={TASK_STATUS_SHAPE[task.status]} />
                      {t(`backlog.statuses.${task.status}`)}
                    </span>
                  </TableCell>
                ) : null}
                {showProject ? (
                  <TableCell className="issue-col-project">
                    <span className={cn("issue-project", !context.projectName && "issue-project--none")}>
                      {context.projectName ?? "—"}
                    </span>
                  </TableCell>
                ) : null}
                <TableCell className="task-col-priority"><PriorityBadge priority={task.priority} /></TableCell>
                <TableCell className="task-col-assignee">
                  <TaskAssignee
                    task={task}
                    ready={context.ready}
                    agentDisplayName={context.agentDisplayName}
                    agentImageUrl={context.agentImageUrl}
                  />
                </TableCell>
                <TableCell className="task-col-due">
                  <span className={cn(tone !== "neutral" && tone)} data-empty={!task.dueDate || undefined}>
                    {task.dueDate ? formatDueDate(task.dueDate) : "—"}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      ))}
    </Table>
  );
}
