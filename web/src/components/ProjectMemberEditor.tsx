"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { computerId as stableComputerId } from "../lib/createAgent";
import { agentsEligibleForProject } from "../lib/projectPage";
import {
  AGENT_ROLE_OPTIONS,
  type AgentRole,
  type DaemonNodeMonitorRecord,
  type EmployeeAgent,
  type ProjectMember,
  type ProjectRecord,
} from "../types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Drawer } from "@/components/ui/Drawer";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RosterAgentItem, RosterTriggerValue } from "./roster/RosterOption";
import { rosterLabel, useRosterTabs, type RosterTab } from "./roster/RosterTabs";
import {
  AdminDelete,
  ICON,
} from "./icons";

type MemberDraft = {
  agentId: string;
  role: AgentRole;
  functionTitle: string;
  responsibilities: string;
  instructions: string;
  enabled: boolean;
  lead: boolean;
};

const EMPTY_DRAFT: MemberDraft = {
  agentId: "",
  role: "implementer",
  functionTitle: "",
  responsibilities: "",
  instructions: "",
  enabled: true,
  lead: false,
};

function draftKey(draft: MemberDraft): string {
  return JSON.stringify(draft);
}

/* The update API replaces the roster wholesale, so every member save (add,
   edit, remove) re-serializes the current record with one entry changed. */
function rosterPayload(project: ProjectRecord) {
  return project.members.map((member) => ({
    agentId: member.agentId,
    role: member.role,
    functionTitle: member.functionTitle,
    responsibilities: member.responsibilities,
    ...(member.instructions ? { instructions: member.instructions } : {}),
    enabled: member.enabled,
  }));
}

export function ProjectMemberEditor({
  open,
  member,
  project,
  agents,
  computers,
  onClose,
}: {
  open: boolean;
  /** Null member = add mode; an existing member = edit mode. */
  member: ProjectMember | null;
  project: ProjectRecord;
  agents: EmployeeAgent[];
  computers: DaemonNodeMonitorRecord[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const { updateProjectMutation } = useRelayMutations();
  const [draft, setDraft] = useState<MemberDraft>(EMPTY_DRAFT);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [functionTitleError, setFunctionTitleError] = useState<string | null>(null);
  const [responsibilitiesError, setResponsibilitiesError] = useState<string | null>(null);
  const agentTriggerRef = useRef<HTMLButtonElement>(null);
  const functionTitleRef = useRef<HTMLInputElement>(null);
  const responsibilitiesRef = useRef<HTMLTextAreaElement>(null);
  const initializedKeyRef = useRef<string | null>(null);
  const initialVersionRef = useRef(project.version);
  const initialDraftKeyRef = useRef(draftKey(EMPTY_DRAFT));
  const agentLabelId = useId();
  const roleLabelId = useId();

  const runtimeNodeId = useMemo(
    () => computers.find((computer) => stableComputerId(computer) === project.computerId)?.id ?? "",
    [computers, project.computerId],
  );
  const memberAgentIds = useMemo(
    () => new Set(project.members.map((item) => item.agentId)),
    [project.members],
  );
  const candidates = useMemo(
    () => agentsEligibleForProject(agents, project.computerId, runtimeNodeId)
      .filter((agent) => !memberAgentIds.has(agent.id)),
    [agents, project.computerId, runtimeNodeId, memberAgentIds],
  );
  const editingAgent = useMemo(
    () => agents.find((agent) => agent.id === member?.agentId) ?? null,
    [agents, member],
  );
  // Project membership is an agent roster only — a member is one agent with a
  // role, never a whole team — so the shared picker renders no tab strip here.
  const rosterTabs: RosterTab<"agents">[] = [
    { id: "agents", label: t("project.member_agent"), count: candidates.length },
  ];
  const roster = useRosterTabs({ tabs: rosterTabs, activeTab: "agents", label: t("project.member_agent") });

  const busy = updateProjectMutation.isPending;

  useEffect(() => {
    if (!open) {
      initializedKeyRef.current = null;
      return;
    }
    const initializationKey = member ? `${project.id}:${member.agentId}` : `${project.id}:new`;
    if (initializedKeyRef.current === initializationKey) return;
    initializedKeyRef.current = initializationKey;
    initialVersionRef.current = project.version;
    const initial = member
      ? {
          agentId: member.agentId,
          role: member.role,
          functionTitle: member.functionTitle,
          responsibilities: member.responsibilities,
          instructions: member.instructions ?? "",
          enabled: member.enabled,
          lead: member.agentId === project.leadAgentId,
        }
      : EMPTY_DRAFT;
    setDraft(initial);
    setAgentError(null);
    setFunctionTitleError(null);
    setResponsibilitiesError(null);
    initialDraftKeyRef.current = draftKey(initial);
  }, [open, member, project.id, project.version, project.leadAgentId]);

  const dirty = initializedKeyRef.current !== null && draftKey(draft) !== initialDraftKeyRef.current;
  const confirmDiscard = useUnsavedChangesGuard(open && dirty && !busy);

  function patch(patchDraft: Partial<MemberDraft>) {
    setDraft((current) => ({ ...current, ...patchDraft }));
    setAgentError(null);
    setFunctionTitleError(null);
    setResponsibilitiesError(null);
  }

  function pickAgent(agentId: string | null) {
    const agent = agents.find((candidate) => candidate.id === agentId);
    patch({
      agentId: agentId ?? "",
      ...(agent ? { role: agent.defaultRole ?? "implementer", functionTitle: agent.displayName } : {}),
    });
  }

  async function requestClose() {
    if (busy) return;
    if (await confirmDiscard()) onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!member && !draft.agentId) {
      setAgentError(t("project.member_choose_required"));
      agentTriggerRef.current?.focus();
      return;
    }
    if (!draft.functionTitle.trim()) {
      setFunctionTitleError(t("project.member_fields_required"));
      functionTitleRef.current?.focus();
      return;
    }
    if (!draft.responsibilities.trim()) {
      setResponsibilitiesError(t("project.member_fields_required"));
      responsibilitiesRef.current?.focus();
      return;
    }
    const payload = {
      agentId: draft.agentId,
      role: draft.role,
      functionTitle: draft.functionTitle.trim(),
      responsibilities: draft.responsibilities.trim(),
      ...(draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
      enabled: draft.enabled,
    };
    const base = rosterPayload(project);
    const members = member
      ? base.map((item) => (item.agentId === member.agentId ? payload : item))
      : [...base, payload];
    const leadAgentId = draft.lead
      ? draft.agentId
      : project.leadAgentId === draft.agentId
        ? null
        : project.leadAgentId;
    try {
      await updateProjectMutation.mutateAsync({
        projectId: project.id,
        input: { expectedVersion: initialVersionRef.current, leadAgentId, members },
      });
      onClose();
    } catch {
      // The shared mutation handler announces the server error; preserve the form.
    }
  }

  async function remove() {
    if (!member || busy) return;
    const name = editingAgent?.displayName ?? member.agentId;
    const accepted = await confirm({
      title: t("project.member_remove_confirm_title", { name }),
      message: t("project.member_remove_confirm_message"),
      confirmLabel: t("project.member_remove"),
      tone: "danger",
    });
    if (!accepted) return;
    const members = rosterPayload(project).filter((item) => item.agentId !== member.agentId);
    const leadAgentId = project.leadAgentId === member.agentId
      ? members[0]?.agentId ?? null
      : project.leadAgentId;
    try {
      await updateProjectMutation.mutateAsync({
        projectId: project.id,
        input: { expectedVersion: initialVersionRef.current, leadAgentId, members },
      });
      onClose();
    } catch {
      // The shared mutation handler announces the error and keeps the drawer open.
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      kicker={project.name}
      title={member ? t("project.member_edit") : t("project.member_add")}
      subtitle={member ? editingAgent?.displayName ?? member.agentId : undefined}
      width="form"
      closeLabel={t("admin.v2.close_drawer")}
      bodyClassName="adm-drawer-body--column"
    >
      <form className="project-member-form" onSubmit={(event) => void submit(event)} noValidate>
        {!member ? (
          candidates.length ? (
            <Field label={t("project.member_agent")} labelId={agentLabelId} wrapper="div" error={agentError ?? undefined} errorId="project-member-agent-error">
              <Select
                value={draft.agentId}
                onValueChange={pickAgent}
                onOpenChange={(open) => { if (open) roster.resetTab(); }}
              >
                <SelectTrigger
                  ref={agentTriggerRef}
                  className="w-full"
                  aria-labelledby={agentLabelId}
                  data-modal-initial-focus
                  aria-invalid={Boolean(agentError) || undefined}
                  aria-describedby={agentError ? "project-member-agent-error" : undefined}
                >
                  <SelectValue placeholder={t("project.member_choose_agent")}>
                    {(value: string | null) => {
                      const picked = agents.find((candidate) => candidate.id === value);
                      return picked ? <RosterTriggerValue agent={picked} /> : t("project.member_choose_agent");
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent
                  alignItemWithTrigger={false}
                  onKeyDownCapture={roster.onKeyDownCapture}
                  header={roster.header}
                >
                  <SelectGroup aria-label={rosterLabel(rosterTabs, roster.tab)}>
                    {candidates.map((agent) => (
                      <RosterAgentItem key={agent.id} value={agent.id} agent={agent} />
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <p className="project-empty-hint">{t("project.member_no_agents")}</p>
          )
        ) : null}

        {member || draft.agentId ? (
          <>
            <Field label={t("project.role")} labelId={roleLabelId} wrapper="div">
              <Select value={draft.role} onValueChange={(value) => patch({ role: value as AgentRole })}>
                <SelectTrigger className="w-full" aria-labelledby={roleLabelId}>
                  <SelectValue>{(value: AgentRole) => t(`project.roles.${value}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {AGENT_ROLE_OPTIONS.map((role) => (
                    <SelectItem key={role} value={role}>{t(`project.roles.${role}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("project.function_title")} error={functionTitleError ?? undefined} errorId="project-member-function-title-error">
              <Input
                ref={functionTitleRef}
                name="function-title"
                autoComplete="off"
                maxLength={120}
                value={draft.functionTitle}
                onChange={(event) => patch({ functionTitle: event.target.value })}
                aria-invalid={Boolean(functionTitleError) || undefined}
                aria-describedby={functionTitleError ? "project-member-function-title-error" : undefined}
              />
            </Field>
            <Field label={t("project.responsibilities")} error={responsibilitiesError ?? undefined} errorId="project-member-responsibilities-error">
              <Textarea
                ref={responsibilitiesRef}
                name="responsibilities"
                autoComplete="off"
                maxLength={4000}
                rows={3}
                value={draft.responsibilities}
                onChange={(event) => patch({ responsibilities: event.target.value })}
                aria-invalid={Boolean(responsibilitiesError) || undefined}
                aria-describedby={responsibilitiesError ? "project-member-responsibilities-error" : undefined}
              />
            </Field>
            <Field label={t("project.instructions")}>
              <Textarea
                name="instructions"
                autoComplete="off"
                maxLength={8000}
                rows={5}
                value={draft.instructions}
                onChange={(event) => patch({ instructions: event.target.value })}
              />
            </Field>

            <div className="project-member-flags">
              <label className="project-member-flag">
                <Checkbox
                  checked={draft.lead}
                  onCheckedChange={(value) => patch({ lead: value === true })}
                  aria-label={t("project.member_make_lead")}
                />
                <span>{t("project.member_make_lead")}</span>
              </label>
              <label className="project-member-flag">
                <Checkbox
                  checked={draft.enabled}
                  onCheckedChange={(value) => patch({ enabled: value === true })}
                  aria-label={t("project.member_enabled")}
                />
                <span>{t("project.member_enabled")}</span>
              </label>
            </div>
          </>
        ) : null}

        {member ? (
          <div className="adm-drawer-section">
            <h3 className="adm-drawer-section-title">{t("admin.v2.danger_zone")}</h3>
            <div className="adm-drawer-section-actions">
              <Button
                type="button"
                variant="destructive"
                onClick={() => void remove()}
                disabled={busy}
              >
                <AdminDelete size={ICON.sm} aria-hidden="true" />
                {t("project.member_remove")}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={() => void requestClose()} disabled={busy}>
            {t("dialog.cancel")}
          </Button>
          <Button
            size="cta"
            type="submit"
            loading={busy}
          >
            {t("project.member_save")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
