"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { enUS, zhCN } from "react-day-picker/locale";
import { cn } from "@/lib/utils";
import { dateFromKey } from "@/lib/dateKey";
import { isoToday } from "@/lib/routine";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionCalendar, CheckIcon, ICON } from "../icons";
import { PriorityBadge, PriorityGlyph } from "../PriorityBadge";
import { TaskStatusIcon } from "../TaskStatusIcon";
import { TASK_PRIORITIES, dueTone } from "../../lib/backlog";
import { TASK_FLOW_STAGES } from "../../lib/taskFlow";
import { taskDropRejection } from "../../lib/taskDrag";
import { formatDueDate } from "./BacklogChrome";
import { TaskAssignee } from "../TaskAssignee";
import { AssignmentSelect } from "../assignment/AssignmentField";
import {
  taskAssigneeLabel,
  taskAssignmentEditable,
  taskAssignmentOptions,
  type TaskAssignmentChange,
} from "../../lib/taskAssignment";
import type { AgentTeam, EmployeeAgent, ProjectRecord, RelayTaskListItem, TaskPriority, TaskStatus } from "../../types";

/*
 * A row's properties, edited where they are read: the status mark, the
 * priority bars and the due date are each a small control, so changing one
 * never costs a trip into the record. Read-only rows render the same marks
 * with nothing to press.
 */

const DAY_PICKER_LOCALES = { en: enUS, "zh-CN": zhCN } as const;

export function InlineStatus({
  task,
  onChange,
  readOnly = false,
  labeled = false,
}: {
  task: RelayTaskListItem;
  onChange: (status: TaskStatus) => void;
  readOnly?: boolean;
  /** Prints the status word beside the mark — for tables with a status column. */
  labeled?: boolean;
}) {
  const { t } = useTranslation();
  const label = t(`backlog.statuses.${task.status}`);
  const mark = <TaskStatusIcon status={task.status} />;

  if (readOnly) {
    return (
      <span className="inline-field inline-field--static" title={label}>
        {mark}
        <span className={labeled ? undefined : "sr-only"}>{label}</span>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            type="button"
            size="xs"
            className="inline-field"
            aria-label={t("backlog.inline.status_label", { status: label })}
            title={label}
          >
            {mark}
            {labeled ? <span>{label}</span> : null}
          </Button>
        }
      />
      <DropdownMenuContent>
        {TASK_FLOW_STAGES.map((stage) => {
          const rejection = taskDropRejection(task, stage);
          const current = rejection === "same_status";
          return (
            <DropdownMenuItem
              key={stage}
              data-current={current || undefined}
              disabled={rejection === "invalid_transition"}
              onClick={() => { if (!current) onChange(stage); }}
            >
              <TaskStatusIcon status={stage} />
              <span className="flex-1">{t(`backlog.statuses.${stage}`)}</span>
              {current ? <CheckIcon size={ICON.sm} aria-hidden="true" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function InlinePriority({
  priority,
  onChange,
  readOnly = false,
}: {
  priority: TaskPriority;
  onChange: (priority: TaskPriority) => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  if (readOnly) return <PriorityBadge priority={priority} />;
  const label = t(`backlog.priorities.${priority}`);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            type="button"
            size="xs"
            className="inline-field inline-field--icon"
            aria-label={t("backlog.inline.priority_label", { priority: label })}
            title={label}
          >
            <PriorityGlyph priority={priority} />
          </Button>
        }
      />
      <DropdownMenuContent>
        {TASK_PRIORITIES.map((option) => (
          <DropdownMenuItem
            key={option}
            data-current={option === priority || undefined}
            onClick={() => { if (option !== priority) onChange(option); }}
          >
            <PriorityGlyph priority={option} />
            <span className="flex-1">{t(`backlog.priorities.${option}`)}</span>
            {option === priority ? <CheckIcon size={ICON.sm} aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function InlineAssignee({
  task,
  agents,
  teams,
  project,
  display,
  onChange,
  readOnly = false,
}: {
  task: RelayTaskListItem;
  agents: readonly EmployeeAgent[];
  teams: readonly AgentTeam[];
  /** The task's project — its computer decides who may take the task. */
  project?: ProjectRecord | null;
  /** The row's resolved assignee, as the static chip draws it. */
  display: { name?: string; imageUrl?: string | null; ready: boolean };
  onChange: (change: TaskAssignmentChange) => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const chip = (
    <TaskAssignee task={task} ready={display.ready} agentDisplayName={display.name} agentImageUrl={display.imageUrl} />
  );
  if (readOnly || !taskAssignmentEditable(task)) return chip;

  const options = taskAssignmentOptions({
    project,
    agents,
    teams,
    assigneeEmployeeId: task.assigneeEmployeeId ?? task.ownerEmployeeId ?? "",
    assignedAgentId: task.assignedAgentId,
    assignedTeamId: task.assignedTeamId,
  });
  const selectedTeam = task.assignedTeamId
    ? options.teams.find((team) => team.id === task.assignedTeamId)
      ?? { name: t("backlog.assignment_unavailable_team"), members: [], lead: null, enabled: false }
    : undefined;
  const selectedAgent = !selectedTeam && task.assignedAgentId
    ? options.agents.find((agent) => agent.id === task.assignedAgentId)
    : undefined;
  const value = task.assignedTeamId
    ? `team:${task.assignedTeamId}`
    : task.assignedAgentId ? `agent:${task.assignedAgentId}` : "__none__";

  return (
    <AssignmentSelect
      value={value}
      agents={options.agents}
      teams={options.teams}
      selectedAgent={selectedAgent}
      selectedTeam={selectedTeam}
      inline={{ label: t("backlog.inline.assignee_label", { name: taskAssigneeLabel(task, display.name, t) }), content: chip }}
      onSelect={(selection) => {
        const unchanged = selection.kind === "none"
          ? !task.assignedAgentId && !task.assignedTeamId
          : selection.id === (selection.kind === "team" ? task.assignedTeamId : task.assignedAgentId);
        if (!unchanged) onChange(selection);
      }}
    />
  );
}

export function InlineDue({
  task,
  onChange,
  readOnly = false,
}: {
  task: RelayTaskListItem;
  /** A day key ("2026-09-30"), or "" to clear. */
  onChange: (dueDate: string) => void;
  readOnly?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const tone = dueTone(task);
  const formatted = task.dueDate ? formatDueDate(task.dueDate) : null;

  if (readOnly) {
    return (
      <span className={cn(tone !== "neutral" && tone)} data-empty={!task.dueDate || undefined}>
        {formatted ?? "—"}
      </span>
    );
  }

  const selected = dateFromKey(task.dueDate ?? "");
  const locale = DAY_PICKER_LOCALES[i18n.language as keyof typeof DAY_PICKER_LOCALES] ?? enUS;
  const commit = (value: string) => {
    setOpen(false);
    if (value !== (task.dueDate ?? "")) onChange(value);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            type="button"
            size="xs"
            className={cn("inline-field", tone !== "neutral" && tone)}
            data-empty={!formatted || undefined}
            aria-label={formatted ? t("backlog.inline.due_label", { date: formatted }) : t("backlog.inline.due_empty")}
          >
            {formatted ?? <ActionCalendar size={ICON.sm} aria-hidden="true" />}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          locale={locale}
          selected={selected}
          defaultMonth={selected}
          autoFocus
          onSelect={(date) => commit(date ? isoToday(date) : "")}
        />
        {task.dueDate ? (
          <div className="inline-field-popover-foot">
            <Button variant="ghost" type="button" size="xs" onClick={() => commit("")}>
              {t("backlog.inline.clear_due")}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
