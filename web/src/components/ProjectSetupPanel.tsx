"use client";

import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getProjectSetup, RelayApiError } from "../api";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { agentRoleLabel } from "../lib/agentRoleLabel";
import {
  effectiveLead,
  keptMemberIds,
  setupApplyInput,
  setupDraftFromProposal,
  setupDraftingAllowed,
  setupTaskAfterTitles,
  setupTasksApplyInput,
  type SetupDraft,
  type SetupMemberDraft,
  type SetupTaskDraft,
} from "../lib/projectSetup";
import type { RelayTask, UserAgent, ProjectRecord, ProjectSetup } from "../types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { RosterAgentMark } from "./roster/RosterOption";
import { ProjectContextField, ProjectDescriptionField, ProjectGoalField } from "./ProjectFormFields";

export const PROJECT_SETUP_QUERY_KEY = "project-setup";

type PanelProps = {
  project: ProjectRecord;
  setup: ProjectSetup;
  agents: UserAgent[];
  onOpenThread: (threadId: string) => void;
  /** Leave the setup to the owner: the Members tab is where a crew is built by hand. */
  onManual: () => void;
  onTasksCreated?: (tasks: RelayTask[]) => void;
  onViewTasks?: () => void;
};

/** The project's agent-drafted setup while it still needs the owner: being
 *  drafted, failed, or proposed and waiting for review. Applied and dismissed
 *  setups render nothing — the project itself is then the record. */
export function ProjectSetupPanel(props: PanelProps) {
  const { setup } = props;
  if (setup.state === "drafting") return <SetupDrafting {...props} />;
  if (setup.state === "failed") return <SetupFailed {...props} />;
  if (setup.state === "proposed" && setup.proposal) {
    // A new proposal (a revision) replaces the owner's working copy.
    return <SetupReview key={setup.draftId ?? setup.finishedAt ?? setup.startedAt} {...props} proposal={setup.proposal} />;
  }
  return null;
}

function useAgentName(agents: UserAgent[]) {
  const { t } = useTranslation();
  return (agentId: string) => agents.find((agent) => agent.id === agentId)?.displayName ?? t("project.setup_unknown_agent");
}

function SetupShell({ title, body, children, footer, drafting = false }: {
  title: string;
  body?: string;
  children?: ReactNode;
  footer: ReactNode;
  drafting?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className={`project-settings-section project-setup-panel${drafting ? " project-setup-drafting" : ""}`} aria-label={t("project.setup_panel_label")}>
      <header className="project-settings-head">
        <h2 className="workspace-dossier-section-title">{drafting ? <Spinner aria-hidden="true" /> : null}{title}</h2>
        {body ? <p className="project-settings-hint">{body}</p> : null}
      </header>
      {children}
      <footer className="project-settings-foot">{footer}</footer>
    </section>
  );
}

function SetupError({ message }: { message: string | null }) {
  return message ? <p role="alert" className="text-destructive project-setup-error">{message}</p> : <span />;
}

function useDismiss(project: ProjectRecord) {
  const { updateProjectMutation } = useRelayMutations();
  const [error, setError] = useState<string | null>(null);
  async function dismiss(): Promise<boolean> {
    setError(null);
    try {
      await updateProjectMutation.mutateAsync({
        projectId: project.id,
        input: { expectedVersion: project.version, setupResolution: "dismissed" },
      });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }
  return { dismiss, pending: updateProjectMutation.isPending, error };
}

function ThreadButton({ setup, onOpenThread }: Pick<PanelProps, "setup" | "onOpenThread">) {
  const { t } = useTranslation();
  const { threadId } = setup;
  return threadId ? (
    <Button type="button" variant="ghost" onClick={() => onOpenThread(threadId)}>{t("project.setup_open_thread")}</Button>
  ) : null;
}

function SetupDrafting({ project, setup, agents, onOpenThread }: PanelProps) {
  const { t } = useTranslation();
  const agentName = useAgentName(agents);
  const { dismiss, pending, error } = useDismiss(project);
  return (
    <SetupShell
      drafting
      title={t(setup.mode === "plan" ? "project.plan_drafting" : "project.setup_drafting", { agent: agentName(setup.agentId) })}
      footer={(
        <>
          <SetupError message={error} />
          <div className="project-settings-actions">
            <ThreadButton setup={setup} onOpenThread={onOpenThread} />
            <Button type="button" variant="ghost" onClick={() => void dismiss()} disabled={pending}>{t("project.setup_dismiss")}</Button>
          </div>
        </>
      )}
    />
  );
}

function SetupFailed({ project, setup, agents, onOpenThread, onManual }: PanelProps) {
  const { t } = useTranslation();
  const agentName = useAgentName(agents);
  const { startProjectSetupMutation } = useRelayMutations();
  const { dismiss, pending, error } = useDismiss(project);
  const plan = setup.mode === "plan";
  const body = setup.error === "setup_no_proposal"
    ? t("project.setup_failed_no_proposal", { agent: agentName(setup.agentId) })
    : setup.error === "setup_run_failed"
      ? t("project.setup_failed_run")
      : t(plan ? "project.plan_failed_generic" : "project.setup_failed_generic");
  const busy = pending || startProjectSetupMutation.isPending;
  const input = { intent: setup.intent, agentId: setup.agentId };
  const retry = () => startProjectSetupMutation
    .mutateAsync({ projectId: project.id, input: plan ? { ...input, mode: "plan" } : input })
    // The shared mutation handler announces the error.
    .catch(() => undefined);
  return (
    <SetupShell
      title={t(plan ? "project.plan_failed_title" : "project.setup_failed_title")}
      body={body}
      footer={(
        <>
          <SetupError message={error} />
          <div className="project-settings-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void dismiss().then((done) => { if (done && !plan) onManual(); })}>
              {t(plan ? "project.setup_dismiss" : "project.setup_manual")}
            </Button>
            <ThreadButton setup={setup} onOpenThread={onOpenThread} />
            {setupDraftingAllowed(project, setup.mode) ? (
              <Button type="button" disabled={busy} loading={startProjectSetupMutation.isPending} onClick={() => void retry()}>
                {t("project.setup_try_again")}
              </Button>
            ) : null}
          </div>
        </>
      )}
    />
  );
}

function SetupReview({ project, setup, agents, onOpenThread, onTasksCreated, onViewTasks, proposal }: PanelProps & {
  proposal: NonNullable<ProjectSetup["proposal"]>;
}) {
  const { t } = useTranslation();
  const agentName = useAgentName(agents);
  const { updateProjectMutation, applySetupTasksMutation, startProjectSetupMutation } = useRelayMutations();
  // A plan proposes only tasks: the crew and brief stay as they are.
  const plan = setup.mode === "plan";
  const [draft, setDraft] = useState<SetupDraft>(() => setupDraftFromProposal(proposal, project));
  /* The record carries the proposal; the setup endpoint adds whether each
     proposed member could still be applied. When it answers, a member that
     can no longer join is unticked and explained — Apply's own validation
     stays the backstop either way. */
  const annotated = useQuery({
    queryKey: [PROJECT_SETUP_QUERY_KEY, project.id, setup.finishedAt],
    queryFn: ({ signal }) => getProjectSetup(project.id, signal),
    enabled: !plan && draft.members.length > 0,
  });
  const [issuesSeen, setIssuesSeen] = useState(false);
  const annotatedMembers = annotated.data?.setup?.proposal?.members;
  if (annotatedMembers && !issuesSeen) {
    setIssuesSeen(true);
    const issues = new Map(annotatedMembers.map((member) => [member.agentId, member.issue]));
    setDraft((current) => {
      const members = current.members.map((member) => {
        const issue = issues.get(member.agentId);
        return issue ? { ...member, issue, include: false } : member;
      });
      return { ...current, members, leadAgentId: effectiveLead(members, current.leadAgentId) };
    });
  }
  const [revision, setRevision] = useState("");
  const [showRevision, setShowRevision] = useState(false);
  const revisionId = useId();
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const { dismiss, pending: dismissing, error: dismissError } = useDismiss(project);
  const busy = applying || startProjectSetupMutation.isPending || dismissing;
  const keptTasks = draft.tasks.filter((task) => task.include && task.title.trim());
  const selectedMembers = keptMemberIds(draft);
  const assignees = !plan && selectedMembers.size > 0
    ? selectedMembers
    : new Set(project.members.filter((member) => member.enabled).map((member) => member.agentId));

  const patchMember = (agentId: string, patch: Partial<SetupMemberDraft>) => setDraft((current) => {
    const members = current.members.map((member) => (member.agentId === agentId ? { ...member, ...patch } : member));
    return { ...current, members, leadAgentId: effectiveLead(members, current.leadAgentId) };
  });

  async function apply() {
    if (busy) return;
    setError(null);
    if (keptTasks.length && !setup.draftId) {
      setError(t("project.setup_stale_draft"));
      return;
    }
    setApplying(true);
    try {
      if (!plan) {
        const input = setupApplyInput(project, draft, { resolveSetup: keptTasks.length === 0 });
        try {
          await updateProjectMutation.mutateAsync({ projectId: project.id, input, baseProject: project });
        } catch (cause) {
          setError(cause instanceof RelayApiError && cause.code === "project_version_conflict"
            ? t("project.setup_conflict")
            : cause instanceof Error ? cause.message : String(cause));
          return;
        }
      }
      if (keptTasks.length && setup.draftId) {
        try {
          await applySetupTasksMutation.mutateAsync({
            projectId: project.id,
            input: setupTasksApplyInput(setup.draftId, draft, assignees),
            onTasksCreated,
            onViewTasks,
          });
        } catch (cause) {
          setError(t("project.setup_tasks_failed", { message: cause instanceof Error ? cause.message : String(cause) }));
        }
      }
    } finally {
      setApplying(false);
    }
  }

  async function revise() {
    if (busy) return;
    if (!revision.trim()) {
      setRevisionError(t("project.setup_revise_required"));
      return;
    }
    try {
      await startProjectSetupMutation.mutateAsync({
        projectId: project.id,
        input: plan ? { intent: revision.trim(), revise: true, mode: "plan" } : { intent: revision.trim(), revise: true },
      });
      setRevision("");
    } catch {
      // The shared mutation handler announces the error; keep the note.
    }
  }

  return (
    <SetupShell
      title={t(plan ? "project.plan_review_title" : "project.setup_review_title")}
      body={t(plan ? "project.plan_review_body" : "project.setup_review_body", { agent: agentName(setup.agentId) })}
      footer={(
        <>
          <SetupError message={error ?? dismissError} />
          <div className="project-settings-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void dismiss()}>{t("project.setup_dismiss")}</Button>
            <ThreadButton setup={setup} onOpenThread={onOpenThread} />
            <Button
              type="button"
              disabled={busy || (plan && !keptTasks.length)}
              loading={applying}
              loadingLabel={t("project.setup_applying")}
              onClick={() => void apply()}
            >
              {plan ? t("project.plan_apply_tasks", { count: keptTasks.length })
                : keptTasks.length ? t("project.setup_apply_tasks", { count: keptTasks.length }) : t("project.setup_apply")}
            </Button>
          </div>
        </>
      )}
    >
      <fieldset className="project-settings-fields" disabled={busy}>
        {plan ? null : (<>
        <Field label={t("project.name")}>
          <Input
            name="setup-name"
            autoComplete="off"
            maxLength={120}
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </Field>
        <ProjectGoalField value={draft.goal} onChange={(goal) => setDraft((current) => ({ ...current, goal }))} />
        <details className="project-setup-disclosure">
          <summary>{t("project.setup_edit_brief")}
            {draft.description || draft.context ? <span className="project-setup-preview">{draft.description || draft.context}</span> : null}
          </summary>
          <div className="project-setup-group">
            <ProjectDescriptionField value={draft.description} onChange={(description) => setDraft((current) => ({ ...current, description }))} />
            <ProjectContextField value={draft.context} onChange={(context) => setDraft((current) => ({ ...current, context }))} />
          </div>
        </details>

        <div className="project-setup-group">
          <h3 className="project-setup-subhead">{t("project.setup_crew")}</h3>
          {draft.members.length === 0 ? <p className="project-settings-hint">{t("project.setup_crew_empty")}</p> : (
            <ul className="project-setup-list">
              {draft.members.map((member) => (
                <SetupMemberRow
                  key={member.agentId}
                  member={member}
                  name={agentName(member.agentId)}
                  agent={agents.find((agent) => agent.id === member.agentId)}
                  lead={draft.leadAgentId === member.agentId}
                  onChange={(patch) => patchMember(member.agentId, patch)}
                  onMakeLead={() => setDraft((current) => ({ ...current, leadAgentId: effectiveLead(current.members, member.agentId) }))}
                />
              ))}
            </ul>
          )}
        </div>
        </>)}

        {draft.tasks.length ? (
          <div className="project-setup-group">
            <div className="project-plan-actions project-setup-task-heading">
              <h3 className="project-setup-subhead">{t("project.setup_selected_tasks", { selected: keptTasks.length, total: draft.tasks.length })}</h3>
              <Button type="button" variant="ghost" size="dense" onClick={() => setDraft((current) => ({
                ...current,
                tasks: current.tasks.map((task) => ({ ...task, include: keptTasks.length !== current.tasks.length })),
              }))}>
                {t(keptTasks.length === draft.tasks.length ? "project.setup_select_none" : "project.setup_select_all")}
              </Button>
            </div>
            <ol className="project-setup-list">
              {draft.tasks.map((task) => (
                <SetupTaskRow
                  key={task.key}
                  task={task}
                  tasks={draft.tasks}
                  assignee={task.assignedAgentId && assignees.has(task.assignedAgentId) ? agentName(task.assignedAgentId) : undefined}
                  onInclude={(include) => setDraft((current) => ({
                    ...current,
                    tasks: current.tasks.map((item) => (item.key === task.key ? { ...item, include } : item)),
                  }))}
                />
              ))}
            </ol>
            <p className="project-settings-hint">{t("project.setup_tasks_backlog_hint")}</p>
          </div>
        ) : null}

        {proposal.rationale ? (
          <details className="project-setup-disclosure">
            <summary>{t(plan ? "project.plan_rationale" : "project.setup_rationale")}</summary>
            <p className="project-setup-rationale">{proposal.rationale}</p>
          </details>
        ) : null}

        {setupDraftingAllowed(project, setup.mode) ? <div>
          <Button type="button" variant="outline" size="dense" aria-expanded={showRevision}
            aria-controls={showRevision ? revisionId : undefined} onClick={() => setShowRevision(!showRevision)}>
            {t("project.setup_revise")}
          </Button>
        </div> : null}
        {showRevision ? <div className="project-setup-group" id={revisionId}>
          <Field label={t("project.setup_revise_label")} error={revisionError ?? undefined} errorId="project-setup-revise-error">
            <Textarea
              name="setup-revision"
              rows={2}
              maxLength={4000}
              placeholder={t("project.setup_revise_placeholder")}
              value={revision}
              onChange={(event) => { setRevision(event.target.value); setRevisionError(null); }}
              aria-invalid={Boolean(revisionError) || undefined}
              aria-describedby={revisionError ? "project-setup-revise-error" : undefined}
            />
          </Field>
          <div className="project-plan-actions">
            <Button type="button" variant="outline" disabled={busy} loading={startProjectSetupMutation.isPending} onClick={() => void revise()}>
              {t("project.setup_send_revision")}
            </Button>
          </div>
        </div> : null}
      </fieldset>
    </SetupShell>
  );
}

function SetupTaskRow({ task, tasks, assignee, onInclude }: {
  task: SetupTaskDraft;
  tasks: readonly SetupTaskDraft[];
  assignee?: string;
  onInclude: (include: boolean) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const after = setupTaskAfterTitles(task, tasks);
  const existing = task.afterTaskIds?.length ?? 0;
  return (
    <li className="project-setup-item" data-excluded={task.include ? undefined : ""}>
      <label className="project-member-flag">
        <Checkbox checked={task.include} onCheckedChange={(value) => onInclude(value === true)} />
        <span>{task.title}</span>
      </label>
      {task.assignedAgentId || after.length || existing ? (
        <div className="project-setup-task-meta">
          {task.assignedAgentId ? <span>{assignee ?? t("project.setup_task_unassigned")}</span> : null}
          {after.length ? <span>{t("project.setup_task_after", { tasks: after.join(", ") })}</span> : null}
          {existing ? <span>{t("project.setup_task_after_existing", { count: existing })}</span> : null}
        </div>
      ) : null}
      {task.description ? (
        <button type="button" className="project-settings-hint project-setup-task-description" aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}>
          {task.description}
        </button>
      ) : null}
    </li>
  );
}

function SetupMemberRow({ member, name, agent, lead, onChange, onMakeLead }: {
  member: SetupMemberDraft;
  name: string;
  /** Absent when the proposed agent is no longer on the roster. */
  agent?: UserAgent;
  lead: boolean;
  onChange: (patch: Partial<SetupMemberDraft>) => void;
  onMakeLead: () => void;
}) {
  const { t } = useTranslation();
  const blocked = Boolean(member.issue);
  const inactive = blocked || !member.include;
  const issueId = `setup-member-issue-${member.agentId}`;
  const role = agentRoleLabel(agent, t);
  return (
    <li className="project-setup-item" data-excluded={member.include ? undefined : ""}>
      <div className="project-setup-member-head">
        <label className="project-member-flag">
          <Checkbox
            checked={member.include}
            disabled={blocked}
            aria-describedby={blocked ? issueId : undefined}
            onCheckedChange={(value) => onChange({ include: value === true })}
          />
          {agent ? <RosterAgentMark agent={agent} /> : null}
          <strong translate="no">{name}</strong>
        </label>
        {role ? <span className="project-settings-hint">{role}</span> : null}
        <label className="project-member-flag">
          <Checkbox checked={lead} disabled={inactive} onCheckedChange={(value) => { if (value === true) onMakeLead(); }} />
          <span>{t("project.setup_member_lead")}</span>
        </label>
      </div>
      {blocked ? (
        <p id={issueId} className="project-settings-hint text-destructive">{t(`project.setup_issue.${member.issue}`)}</p>
      ) : (
        <>
          <details className="project-setup-disclosure">
            <summary>{t("project.responsibilities")}
              <span className="project-setup-preview">{member.responsibilities}</span>
            </summary>
            <Textarea
              name={`setup-responsibilities-${member.agentId}`}
              aria-label={`${t("project.responsibilities")} · ${name}`}
              rows={2}
              maxLength={4000}
              disabled={!member.include}
              value={member.responsibilities}
              onChange={(event) => onChange({ responsibilities: event.target.value })}
            />
          </details>
          <details className="project-setup-disclosure">
            <summary>{t("project.instructions")}</summary>
            <Textarea
              name={`setup-instructions-${member.agentId}`}
              aria-label={`${t("project.instructions")} · ${name}`}
              rows={2}
              maxLength={8000}
              disabled={!member.include}
              value={member.instructions ?? ""}
              onChange={(event) => onChange({ instructions: event.target.value })}
            />
          </details>
        </>
      )}
    </li>
  );
}
