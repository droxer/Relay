"use client";

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { compareTaskQueue, TASK_FLOW_STAGES, taskWorkflowStage } from "../lib/taskFlow";
import { taskStartMutationInput } from "../lib/taskBoardForm";
import type { EmployeeAgent, ProjectRecord, RelayTaskListItem } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TonePill } from "./StatusPill";

export function ProjectTasks({ project, tasks, agents }: {
  project: ProjectRecord;
  tasks: RelayTaskListItem[];
  agents: EmployeeAgent[];
}) {
  const { t } = useTranslation();
  const { createTaskMutation, updateTaskMutation, startTaskMutation } = useRelayMutations();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const readOnly = Boolean(project.archivedAt || !project.enabled);
  const work = tasks.filter((task) => task.projectId === project.id && !task.isRoutine && !task.deletedAt)
    .sort(compareTaskQueue);
  const done = work.filter((task) => task.status === "done").length;
  const attention = work.filter((task) => task.status === "blocked" || task.status === "waiting_for_human").length;
  const canStart = project.members.some((member) => member.enabled);

  async function perform(key: string, action: () => Promise<unknown>) {
    if (busy || readOnly) return;
    setBusy(key);
    setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("errors.save_task")); }
    finally { setBusy(null); }
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
          <strong className="project-task-completion">{done}<span> / {work.length}</span></strong>
          <p>{t("project.tasks_completed")}</p>
        </div>
        <div className="project-task-progress-copy">
          <p>{work.length ? t("project.tasks_progress_hint") : t("project.tasks_empty_hint")}</p>
          <div className="project-task-progress" role="progressbar" aria-label={t("project.tasks_progress")}
            aria-valuemin={0} aria-valuemax={work.length || 1} aria-valuenow={done}>
            <span style={{ width: `${work.length ? done / work.length * 100 : 0}%` }} />
          </div>
          {attention > 0 ? <TonePill tone="warn" label={t("project.tasks_attention", { count: attention })} /> : null}
        </div>
      </section>
      {!readOnly ? (
        <form className="project-task-create" onSubmit={create}>
          <Input aria-label={t("backlog.new_task")} placeholder={t("project.tasks_placeholder")}
            maxLength={500} value={title} disabled={busy === "create"} onChange={(event) => setTitle(event.target.value)} />
          <Button type="submit" disabled={Boolean(busy) || !title.trim()}>{t("backlog.new_task")}</Button>
        </form>
      ) : null}
      {error ? <p role="alert" className="project-task-error">{error}</p> : null}
      <div className="project-task-board">
        {TASK_FLOW_STAGES.map((stage) => {
          const items = work.filter((task) => taskWorkflowStage(task) === stage);
          return (
            <section className="project-task-lane" key={stage} aria-label={t(`backlog.statuses.${stage}`)}>
              <h3><span>{t(`backlog.statuses.${stage}`)}</span><span className="tnum">{items.length}</span></h3>
              {items.length ? items.map((task) => {
                const needsAttention = task.status === "blocked" || task.status === "waiting_for_human";
                const assignee = agents.find((agent) => agent.id === task.assignedAgentId)?.displayName
                  || (task.assignedAgentId ? task.assignedAgentId : t("project.tasks_project_team"));
                return (
                  <article className="project-task-card" key={task.id}>
                    <a className="project-task-title" href={`/backlog/${encodeURIComponent(task.id)}`}>{task.title}</a>
                    <TonePill tone={needsAttention ? "warn" : task.status === "done" ? "good" : "neutral"}
                      label={t(`backlog.statuses.${task.status}`)} live={task.status === "running"} />
                    <div className="project-task-meta"><span>{assignee}</span><span>{t(`backlog.priorities.${task.priority}`)}</span></div>
                    {task.dueDate ? <time dateTime={task.dueDate}>{t("project.tasks_due", { date: task.dueDate })}</time> : null}
                    {task.blockerReason ? <p className="project-task-error">{task.blockerReason}</p> : null}
                    {!readOnly && (task.status === "backlog" || task.status === "assigned") ? (
                      <Button type="button" variant="outline" size="dense" disabled={Boolean(busy) || !canStart}
                        tooltip={!canStart ? t("project.tasks_add_team") : undefined}
                        onClick={() => void perform(task.id, () => startTaskMutation.mutateAsync(taskStartMutationInput(task)))}>
                        {t("project.tasks_start")}
                      </Button>
                    ) : null}
                    {!readOnly && task.status === "review" ? (
                      <Button type="button" variant="outline" size="dense" disabled={Boolean(busy)}
                        onClick={() => void perform(task.id, () => updateTaskMutation.mutateAsync({ taskId: task.id, input: { status: "done" } }))}>
                        {t("project.tasks_accept")}
                      </Button>
                    ) : null}
                  </article>
                );
              }) : <p className="project-task-lane-empty">{t("project.tasks_lane_empty")}</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
