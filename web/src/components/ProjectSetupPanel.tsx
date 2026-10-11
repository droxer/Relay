"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getProjectSetup, RelayApiError } from "../api";
import { useRelayMutations } from "../hooks/useRelayMutations";
import {
  effectiveLead,
  setupApplyInput,
  setupDraftFromProposal,
  setupTaskInputs,
  type SetupDraft,
  type SetupMemberDraft,
} from "../lib/projectSetup";
import { AGENT_ROLE_OPTIONS, type AgentRole, type EmployeeAgent, type ProjectRecord, type ProjectSetup } from "../types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RosterAgentMark } from "./roster/RosterOption";
import { ProjectContextField, ProjectDescriptionField, ProjectGoalField } from "./ProjectFormFields";

export const PROJECT_SETUP_QUERY_KEY = "project-setup";

type PanelProps = {
  project: ProjectRecord;
  setup: ProjectSetup;
  agents: EmployeeAgent[];
  onOpenThread: (threadId: string) => void;
  /** Leave the setup to the owner: the Members tab is where a crew is built by hand. */
  onManual: () => void;
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
    return <SetupReview key={setup.finishedAt ?? setup.startedAt} {...props} />;
  }
  return null;
}

function useAgentName(agents: EmployeeAgent[]) {
  const { t } = useTranslation();
  return (agentId: string) => agents.find((agent) => agent.id === agentId)?.displayName ?? t("project.setup_unknown_agent");
}

function SetupShell({ title, body, children, footer }: {
  title: string;
  body?: string;
  children?: ReactNode;
  footer: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="project-settings-section project-setup-panel" aria-label={t("project.setup_panel_label")}>
      <header className="project-settings-head">
        <h2 className="workspace-dossier-section-title">{title}</h2>
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
  const threadId = setup.threadId;
  if (!threadId) return null;
  return <Button type="button" variant="outline" onClick={() => onOpenThread(threadId)}>{t("project.setup_open_thread")}</Button>;
}

function SetupDrafting({ project, setup, agents, onOpenThread }: PanelProps) {
  const { t } = useTranslation();
  const agentName = useAgentName(agents);
  const { dismiss, pending, error } = useDismiss(project);
  return (
    <SetupShell
      title={t("project.setup_drafting_title")}
      body={t("project.setup_drafting_body", { agent: agentName(setup.agentId) })}
      footer={(
        <>
          <SetupError message={error} />
          <div className="project-settings-actions">
            <Button type="button" variant="ghost" onClick={() => void dismiss()} disabled={pending}>{t("project.setup_dismiss")}</Button>
            <ThreadButton setup={setup} onOpenThread={onOpenThread} />
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
  const body = setup.error === "setup_no_proposal"
    ? t("project.setup_failed_no_proposal", { agent: agentName(setup.agentId) })
    : setup.error === "setup_run_failed"
      ? t("project.setup_failed_run")
      : t("project.setup_failed_generic");
  const busy = pending || startProjectSetupMutation.isPending;
  const retry = () => startProjectSetupMutation
    .mutateAsync({ projectId: project.id, input: { intent: setup.intent, agentId: setup.agentId } })
    // The shared mutation handler announces the error.
    .catch(() => undefined);
  return (
    <SetupShell
      title={t("project.setup_failed_title")}
      body={body}
      footer={(
        <>
          <SetupError message={error} />
          <div className="project-settings-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void dismiss().then((done) => { if (done) onManual(); })}>
              {t("project.setup_manual")}
            </Button>
            <ThreadButton setup={setup} onOpenThread={onOpenThread} />
            <Button type="button" disabled={busy} loading={startProjectSetupMutation.isPending} onClick={() => void retry()}>
              {t("project.setup_try_again")}
            </Button>
          </div>
        </>
      )}
    />
  );
}

function SetupReview({ project, setup, agents, onOpenThread }: PanelProps) {
  const { t } = useTranslation();
  const agentName = useAgentName(agents);
  const { updateProjectMutation, createTaskMutation, startProjectSetupMutation } = useRelayMutations();
  const [draft, setDraft] = useState<SetupDraft>(() => setupDraftFromProposal(setup.proposal!, project));
  /* The record carries the proposal; the setup endpoint adds whether each
     proposed member could still be applied. When it answers, a member that
     can no longer join is unticked and explained — Apply's own validation
     stays the backstop either way. */
  const annotated = useQuery({
    queryKey: [PROJECT_SETUP_QUERY_KEY, project.id, setup.finishedAt],
    queryFn: ({ signal }) => getProjectSetup(project.id, signal),
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
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { dismiss, pending: dismissing, error: dismissError } = useDismiss(project);
  const busy = updateProjectMutation.isPending || startProjectSetupMutation.isPending || dismissing;

  const patchMember = (agentId: string, patch: Partial<SetupMemberDraft>) => setDraft((current) => {
    const members = current.members.map((member) => (member.agentId === agentId ? { ...member, ...patch } : member));
    return { ...current, members, leadAgentId: effectiveLead(members, current.leadAgentId) };
  });

  async function apply() {
    if (busy) return;
    setError(null);
    try {
      await updateProjectMutation.mutateAsync({ projectId: project.id, input: setupApplyInput(project, draft) });
    } catch (cause) {
      setError(cause instanceof RelayApiError && cause.code === "project_version_conflict"
        ? t("project.setup_conflict")
        : cause instanceof Error ? cause.message : String(cause));
      return;
    }
    let failed = 0;
    for (const task of setupTaskInputs(project, draft)) {
      try {
        await createTaskMutation.mutateAsync(task);
      } catch {
        failed += 1;
      }
    }
    if (failed) setError(t("project.setup_tasks_partial", { count: failed }));
  }

  async function revise() {
    if (busy) return;
    if (!revision.trim()) {
      setRevisionError(t("project.setup_revise_required"));
      return;
    }
    try {
      await startProjectSetupMutation.mutateAsync({ projectId: project.id, input: { intent: revision.trim(), revise: true } });
      setRevision("");
    } catch {
      // The shared mutation handler announces the error; keep the note.
    }
  }

  return (
    <SetupShell
      title={t("project.setup_review_title")}
      body={t("project.setup_review_body", { agent: agentName(setup.agentId) })}
      footer={(
        <>
          <SetupError message={error ?? dismissError} />
          <div className="project-settings-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void dismiss()}>{t("project.setup_dismiss")}</Button>
            <ThreadButton setup={setup} onOpenThread={onOpenThread} />
            <Button type="button" disabled={busy} loading={updateProjectMutation.isPending} loadingLabel={t("project.setup_applying")} onClick={() => void apply()}>
              {t("project.setup_apply")}
            </Button>
          </div>
        </>
      )}
    >
      <fieldset className="project-settings-fields" disabled={busy}>
        {setup.proposal?.rationale ? (
          <div className="project-setup-group">
            <h3 className="project-setup-subhead">{t("project.setup_rationale")}</h3>
            <p className="project-setup-rationale">{setup.proposal.rationale}</p>
          </div>
        ) : null}
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
        <ProjectDescriptionField value={draft.description} onChange={(description) => setDraft((current) => ({ ...current, description }))} />
        <ProjectContextField value={draft.context} onChange={(context) => setDraft((current) => ({ ...current, context }))} />

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

        {draft.tasks.length ? (
          <div className="project-setup-group">
            <h3 className="project-setup-subhead">{t("project.setup_first_tasks")}</h3>
            <ul className="project-setup-list">
              {draft.tasks.map((task, index) => (
                <li key={`${index}-${task.title}`} className="project-setup-item">
                  <label className="project-member-flag">
                    <Checkbox
                      checked={task.include}
                      onCheckedChange={(value) => setDraft((current) => ({
                        ...current,
                        tasks: current.tasks.map((item, at) => (at === index ? { ...item, include: value === true } : item)),
                      }))}
                    />
                    <span>{task.title}</span>
                  </label>
                  {task.description ? <p className="project-settings-hint project-setup-detail">{task.description}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="project-setup-group">
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
          <div>
            <Button type="button" variant="outline" disabled={busy} loading={startProjectSetupMutation.isPending} onClick={() => void revise()}>
              {t("project.setup_revise")}
            </Button>
          </div>
        </div>
      </fieldset>
    </SetupShell>
  );
}

function SetupMemberRow({ member, name, agent, lead, onChange, onMakeLead }: {
  member: SetupMemberDraft;
  name: string;
  /** Absent when the proposed agent is no longer on the roster. */
  agent?: EmployeeAgent;
  lead: boolean;
  onChange: (patch: Partial<SetupMemberDraft>) => void;
  onMakeLead: () => void;
}) {
  const { t } = useTranslation();
  const blocked = Boolean(member.issue);
  const inactive = blocked || !member.include;
  const issueId = `setup-member-issue-${member.agentId}`;
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
        <Select value={member.role} disabled={inactive} onValueChange={(value) => onChange({ role: value as AgentRole })}>
          <SelectTrigger className="project-setup-role" aria-label={`${t("project.role")} · ${name}`}>
            <SelectValue>{(value: AgentRole) => t(`project.roles.${value}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {AGENT_ROLE_OPTIONS.map((role) => (
              <SelectItem key={role} value={role}>{t(`project.roles.${role}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="project-member-flag">
          <Checkbox checked={lead} disabled={inactive} onCheckedChange={(value) => { if (value === true) onMakeLead(); }} />
          <span>{t("project.setup_member_lead")}</span>
        </label>
      </div>
      {blocked ? (
        <p id={issueId} className="project-settings-hint text-destructive">{t(`project.setup_issue.${member.issue}`)}</p>
      ) : (
        <Textarea
          name={`setup-responsibilities-${member.agentId}`}
          aria-label={`${t("project.responsibilities")} · ${name}`}
          rows={2}
          maxLength={4000}
          disabled={!member.include}
          value={member.responsibilities}
          onChange={(event) => onChange({ responsibilities: event.target.value })}
        />
      )}
    </li>
  );
}
