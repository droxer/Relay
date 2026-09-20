"use client";

import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../hooks/useRelayMutations";
import {
  laneExceptionStatus,
  projectTaskAssignee,
  projectTaskLanes,
  projectTaskProgress,
  projectTaskQueue,
  type ProjectTaskAssignee,
} from "../lib/projectTasks";
import { projectReadOnly } from "../lib/projectPage";
import { taskStartMutationInput } from "../lib/taskBoardForm";
import type { AgentTeam, EmployeeAgent, ProjectRecord, RelayTaskListItem } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StateMark } from "./StateMark";
import { TASK_STATUS_SHAPE } from "./task-board/backlogVocabulary";
import { recordDate } from "./task-record/recordBandFacts";

/** The words for an assignee the roster could not resolve — never its raw id. */
function assigneeLabel(
  assignee: ProjectTaskAssignee,
  t: (key: string) => string,
): string {
  switch (assignee.kind) {
    case "agent":
    case "team":
      return assignee.name;
    case "agent-missing":
      return t("backlog.assignment_unavailable_agent");
    case "team-missing":
      return t("backlog.assignment_unavailable_team");
    default:
      return t("project.tasks_project_team");
  }
}

export function ProjectTasks({ project, tasks, agents, teams, locale, onOpenRecord }: {
  project: ProjectRecord;
  tasks: RelayTaskListItem[];
  agents: EmployeeAgent[];
  teams: AgentTeam[];
  locale: string;
  /** Opens the task's record as a drawer over this project. */
  onOpenRecord: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const { createTaskMutation, updateTaskMutation, startTaskMutation } = useRelayMutations();
  const [title, setTitle] = useState("");
  const pendingActions = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  /* Errors are keyed by the action that raised them, so a failed Start on the
     fifth card reports on that card instead of at the top of the panel. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const readOnly = projectReadOnly(project);
  const work = projectTaskQueue(tasks, project.id);
  const progress = projectTaskProgress(work);
  const canStart = project.members.some((member) => member.enabled);

  // Keep each action locked until its own request settles.
  async function perform(key: string, action: () => Promise<unknown>) {
    if (pendingActions.current.has(key) || readOnly) return;
    pendingActions.current.add(key);
    setBusy(new Set(pendingActions.current));
    setErrors((current) => {
      const { [key]: _cleared, ...rest } = current;
      return rest;
    });
    try { await action(); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : t("errors.save_task");
      setErrors((current) => ({ ...current, [key]: message }));
    }
    finally {
      pendingActions.current.delete(key);
      setBusy(new Set(pendingActions.current));
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    void perform("create", async () => {
      await createTaskMutation.mutateAsync({ title: title.trim(), projectId: project.id, status: "backlog" });
      setTitle("");
    });
  }

  return (
    <div className="project-tasks">
      <section className="project-task-summary" aria-label={t("project.tasks_progress")}>
        <div>
          <span className="project-task-eyebrow">{t("project.tasks_progress")}</span>
          <strong className="project-task-completion">{progress.done}<span> / {progress.total}</span></strong>
          <p>{t("project.tasks_completed")}</p>
        </div>
        <div className="project-task-progress-copy">
          <p>{progress.total ? t("project.tasks_progress_hint") : t("project.tasks_empty_hint")}</p>
          <div className="project-task-progress" role="progressbar" aria-label={t("project.tasks_progress")}
            aria-valuemin={0} aria-valuemax={progress.total || 1} aria-valuenow={progress.done}>
            <span style={{ width: `${progress.percent}%` }} />
          </div>
          {progress.attention > 0 ? (
            <span className="project-task-attention">
              <StateMark shape={TASK_STATUS_SHAPE.blocked} />
              {t("project.tasks_attention", { count: progress.attention })}
            </span>
          ) : null}
        </div>
      </section>
      {!readOnly ? (
        <form className="project-task-create" onSubmit={create}>
          <Input aria-label={t("backlog.new_task")} placeholder={t("project.tasks_placeholder")}
            maxLength={500} value={title} disabled={busy.has("create")} onChange={(event) => setTitle(event.target.value)} />
          <Button type="submit" loading={busy.has("create")} disabled={busy.has("create") || !title.trim()}>{t("backlog.new_task")}</Button>
        </form>
      ) : null}
      {errors.create ? <p role="alert" className="project-task-failure">{errors.create}</p> : null}
      <div className="project-task-board">
        {projectTaskLanes(work).map(({ stage, tasks: items }) => (
          <section className="project-task-lane" key={stage} aria-label={t(`backlog.statuses.${stage}`)}>
            <h3><span>{t(`backlog.statuses.${stage}`)}</span><span className="tnum">{items.length}</span></h3>
            {items.length ? items.map((task) => {
              /* Only a status the lane cannot show is worth printing — a lane
                 IS the stage, so restating it made every card read as a
                 contradiction ("Blocked" under a "Running" header). */
              const exception = laneExceptionStatus(task);
              const assignee = assigneeLabel(projectTaskAssignee(task, agents, teams), t);
              return (
                <article className="project-task-card" key={task.id}>
                  {/* The record opens over the project, not by leaving for the
                      backlog board — the project stays the reader's place. */}
                  <button
                    type="button"
                    className="project-task-title"
                    onClick={() => onOpenRecord(task.id)}
                  >
                    {task.title}
                  </button>
                  {exception ? (
                    <span className="project-task-exception">
                      <StateMark shape={TASK_STATUS_SHAPE[exception]} />
                      {t(`backlog.statuses.${exception}`)}
                    </span>
                  ) : null}
                  <div className="project-task-meta"><span>{assignee}</span><span>{t(`backlog.priorities.${task.priority}`)}</span></div>
                  {task.dueDate ? (
                    <time dateTime={task.dueDate}>{t("project.tasks_due", { date: recordDate(task.dueDate, locale) })}</time>
                  ) : null}
                  {task.blockerReason ? <p className="project-task-blocker">{task.blockerReason}</p> : null}
                  {!readOnly && (task.status === "backlog" || task.status === "assigned") ? (
                    <Button type="button" variant="outline" size="dense"
                      loading={busy.has(task.id)} disabled={busy.has(task.id) || !canStart}
                      tooltip={!canStart ? t("project.tasks_add_team") : undefined}
                      onClick={() => void perform(task.id, () => startTaskMutation.mutateAsync(taskStartMutationInput(task)))}>
                      {t("project.tasks_start")}
                    </Button>
                  ) : null}
                  {!readOnly && task.status === "review" ? (
                    <Button type="button" variant="outline" size="dense"
                      loading={busy.has(task.id)} disabled={busy.has(task.id)}
                      onClick={() => void perform(task.id, () => updateTaskMutation.mutateAsync({ taskId: task.id, input: { status: "done" } }))}>
                      {t("project.tasks_accept")}
                    </Button>
                  ) : null}
                  {errors[task.id] ? <p role="alert" className="project-task-failure">{errors[task.id]}</p> : null}
                </article>
              );
            }) : <p className="project-task-lane-empty">{t("project.tasks_lane_empty")}</p>}
          </section>
        ))}
      </div>
    </div>
  );
}
