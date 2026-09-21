"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { agentLabel } from "../../lib/plan";
import { compactDate, compactDueDate, taskAssigneeName } from "../../lib/workspaceFormat";
import type { WorkspaceBriefResponse, WorkspaceBriefSession, WorkspaceBriefTask } from "../../types";
import { PriorityBadge } from "../PriorityBadge";
import { StateMark } from "../StateMark";
import { TASK_STATUS_SHAPE } from "../task-board/backlogVocabulary";
import { RelayEmptyState } from "@/components/RelayEmptyState";
import { Button } from "@/components/ui/button";

/* Shared workspace inspection primitives — the empty/loading/activity
   building blocks used by both AgentDetailPage and TeamWorkspacePage. Kept
   here so the two surfaces don't drift (they previously each declared their
   own). */

/** Centered empty state on the shared RelayEmptyState language: an optional
 *  mark tile (any glyph the caller supplies, or a pulsing dot when `pulse`)
 *  in the relay-empty avatar plate, a title, and an optional hint. The outer
 *  div is layout + live-announcement only; all visuals come from .relay-empty. */
export function WorkspaceEmpty({
  title,
  hint,
  mark,
  pulse = false,
  announce = false,
}: {
  title: string;
  hint?: string;
  mark?: ReactNode;
  pulse?: boolean;
  /** Announce async empty/error results that replace a loading status. */
  announce?: boolean;
}) {
  return (
    <div
      className="workspace-empty-state"
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-atomic={announce || undefined}
    >
      <RelayEmptyState
        title={title}
        hint={hint}
        illustration={
          mark || pulse ? (
            <span className={`relay-empty-avatar${pulse ? " is-pulse" : ""}`}>{mark}</span>
          ) : undefined
        }
      />
    </div>
  );
}

export function WorkspaceLoading({ label }: { label: string }) {
  return (
    <div className="workspace-loading" role="status" aria-live="polite">
      <div className="workspace-loading-bar" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/* The three sections below used to take `panelId` / `labelledBy` and paint
   `role="tabpanel"` on themselves, because the pages that render them wired
   their tabs by hand. They are inside a `TabsContent` now, which IS the panel
   and owns the id wiring — a second `role="tabpanel"` nested in the first
   would be the bug, not the feature. */

/** Skeleton for the activities tab while the brief loads. */
export function ActivitiesSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      className="workspace-inspect workspace-activities"
      aria-busy="true"
    >
      <span className="sr-only" role="status">{t("workspace.loading")}</span>
      <div className="workspace-activity-sections">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="workspace-activity-section workspace-skeleton-pane">
            <div className="workspace-skeleton workspace-skeleton-line" />
            <div className="workspace-skeleton workspace-skeleton-line short" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Tabpanel-aware error state with retry. `eyebrow` is optional so callers
 *  whose message already names the failure don't render it twice. */
export function WorkspaceError({
  message,
  eyebrow,
  onRetry,
}: {
  message: string;
  eyebrow?: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="workspace-inspect">
      <div className="workspace-error" role="alert">
        {eyebrow ? <span className="workspace-eyebrow">{eyebrow}</span> : null}
        <p>{message}</p>
        <Button variant="default" type="button" className="h-auto" onClick={onRetry}>
          {t("workspace.retry")}
        </Button>
      </div>
    </div>
  );
}

function ActivitySection({ title, count, children }: { title: string; count: number; index?: number; children: ReactNode }) {
  return (
    <section className="workspace-activity-section">
      <header className="workspace-activity-head">
        <h2>{title}</h2>
        <span className="tnum">{count}</span>
      </header>
      {children}
    </section>
  );
}

function ActivityRow({ title, meta, onClick }: { title: string; meta: string; onClick?: () => void }) {
  if (!onClick) {
    return (
      <div className="workspace-pick workspace-activity-pick is-static">
        <span className="workspace-pick-title">{title}</span>
        <span className="workspace-pick-meta tnum">{meta}</span>
      </div>
    );
  }
  return (
    <Button variant="ghost" type="button" className="workspace-pick workspace-activity-pick" onClick={onClick}>
      <span className="workspace-pick-title">{title}</span>
      <span className="workspace-pick-meta tnum">{meta}</span>
    </Button>
  );
}

function sessionTitle(session: WorkspaceBriefSession): string {
  return session.title?.trim() || session.taskGoal?.trim() || session.id;
}

function taskTitle(task: WorkspaceBriefTask): string {
  return task.title?.trim() || task.id;
}

/** Sessions carry `SessionStatus`, not `TaskStatus` — `completed`, `failed`,
 *  and `cancelled` have no `backlog.statuses.*` key and used to fall through
 *  to the raw lowercase enum. Label them from the thread vocabulary. */
function sessionStatusLabel(
  status: WorkspaceBriefSession["status"] | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!status) return "";
  return t(`thread.statuses.${status}`, { defaultValue: status });
}

/** A brief task as a card, not a one-line pick: the state mark and priority
 *  badge flank the title, and the meta line names who owns it (assignee),
 *  when it is due, and when it last moved. Status keeps its text label — the
 *  10px mark alone cannot carry eight lifecycle states. */
function ActivityTaskCard({
  task,
  agents,
  onOpen,
}: {
  task: WorkspaceBriefTask;
  agents?: ReadonlyArray<{ id: string; displayName: string }>;
  onOpen?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const assigneeName = taskAssigneeName(task, agents);
  const meta = [
    task.status ? t(`backlog.statuses.${task.status}`, { defaultValue: task.status }) : "",
    /* "Assignee <name>" when assigned; the bare "unassigned" label otherwise —
     *  "Assignee unassigned" restates the field name for an empty value. */
    assigneeName ? t("workspace.task_assignee", { name: assigneeName }) : t("backlog.unassigned"),
    task.dueDate ? t("workspace.task_due", { date: compactDueDate(task.dueDate, i18n.language) }) : "",
    compactDate(task.updatedAt, i18n.language),
  ].filter(Boolean).join(" · ");
  const body = (
    <>
      <StateMark shape={task.status ? TASK_STATUS_SHAPE[task.status] : "dashed"} />
      <span className="workspace-task-card-main">
        <span className="workspace-pick-title">{taskTitle(task)}</span>
        <span className="workspace-pick-meta tnum">{meta}</span>
      </span>
      {task.priority ? <PriorityBadge priority={task.priority} /> : null}
    </>
  );
  if (!onOpen) {
    return <div className="workspace-pick workspace-activity-pick workspace-task-card is-static">{body}</div>;
  }
  return (
    <Button variant="ghost" type="button" className="workspace-pick workspace-activity-pick workspace-task-card" onClick={onOpen}>
      {body}
    </Button>
  );
}

/** The activities tabpanel: active-run, thread, and task sections, each
 *  header carrying its own count. Shared by the agent, team, and project
 *  workspace pages; `agents` is the caller's roster, used to resolve a task's
 *  assigned agent id to its display name. */
export function WorkspaceActivities({
  brief,
  onOpenThread,
  emptyMark,
  emptyPulse = false,
  agents,
}: {
  brief?: WorkspaceBriefResponse;
  onOpenThread: (sessionId: string) => void;
  emptyMark?: ReactNode;
  emptyPulse?: boolean;
  agents?: ReadonlyArray<{ id: string; displayName: string }>;
}) {
  const { t, i18n } = useTranslation();
  const activeRuns = brief?.activeRuns ?? [];
  const sessions = brief?.sessions ?? [];
  const tasks = brief?.tasks ?? [];
  const hasActivity = activeRuns.length > 0 || sessions.length > 0 || tasks.length > 0;

  return (
    <div className="workspace-inspect workspace-activities">
      {/* No metric strip. It used to print active-runs / tasks / threads in the
          loudest numerals on the page, directly above three section headers
          carrying those same three counts; counts now live only in the section
          headers. Its last tenant was the team page's readiness chip, which
          restated the RecordBand's availability — and disagreed with it, since
          a busy team rendered as "Unavailable". Status belongs to the band. */}
      <div className="workspace-activity-sections">
        {activeRuns.length ? (
          <ActivitySection title={t("workspace.activity_runs")} count={activeRuns.length} index={0}>
            <ul className="workspace-pick-list">
              {activeRuns.map((run) => (
                <li key={run.runId}>
                  <ActivityRow
                    title={run.taskGoal}
                    meta={[
                      agentLabel(run.agent),
                      compactDate(run.startedAt, i18n.language),
                    ].filter(Boolean).join(" · ")}
                    onClick={() => onOpenThread(run.sessionId)}
                  />
                </li>
              ))}
            </ul>
          </ActivitySection>
        ) : null}

        {sessions.length ? (
          <ActivitySection title={t("workspace.activity_threads")} count={sessions.length} index={activeRuns.length ? 1 : 0}>
            <ul className="workspace-pick-list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <ActivityRow
                    title={sessionTitle(session)}
                    meta={[
                      sessionStatusLabel(session.status, t),
                      session.runCount ? t("workspace.session_runs", { count: session.runCount }) : "",
                      compactDate(session.updatedAt, i18n.language),
                    ].filter(Boolean).join(" · ")}
                    onClick={() => onOpenThread(session.id)}
                  />
                </li>
              ))}
            </ul>
          </ActivitySection>
        ) : null}

        {tasks.length ? (
          <ActivitySection
            title={t("workspace.activity_tasks")}
            count={tasks.length}
            index={(activeRuns.length ? 1 : 0) + (sessions.length ? 1 : 0)}
          >
            <ul className="workspace-pick-list">
              {tasks.map((task) => {
                const linkedSessionId = task.linkedSessionIds[0];
                return (
                  <li key={task.id}>
                    <ActivityTaskCard
                      task={task}
                      agents={agents}
                      onOpen={linkedSessionId ? () => onOpenThread(linkedSessionId) : undefined}
                    />
                  </li>
                );
              })}
            </ul>
          </ActivitySection>
        ) : null}

        {!hasActivity ? (
          <WorkspaceEmpty
            title={t("workspace.no_activity")}
            hint={t("workspace.empty_activity_hint")}
            mark={emptyMark}
            pulse={emptyPulse}
            announce
          />
        ) : null}
      </div>
    </div>
  );
}
