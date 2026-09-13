"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useEmployeeAgents } from "../../hooks/useEmployeeAgents";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { teamMutationInput } from "../../lib/teamForm";
import type { AgentTeam } from "../../types";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RosterAgentItem, RosterTriggerValue } from "../roster/RosterOption";
import { rosterLabel, useRosterTabs, type RosterTab } from "../roster/RosterTabs";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Drawer } from "@/components/ui/Drawer";
import { TeamMemberOption } from "../TeamMemberOption";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";

export function TeamDrawer({
  open,
  team,
  employeeId,
  onClose,
}: {
  open: boolean;
  team?: AgentTeam | null;
  employeeId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const leadLabelId = useId();
  const { confirm } = useDialogs();
  const { createTeamMutation, updateTeamMutation, deleteTeamMutation } = useRelayMutations();
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [leadId, setLeadId] = useState("");
  const [validationError, setValidationError] = useState<
    "name" | "members" | "lead" | null
  >(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const membersRef = useRef<HTMLFieldSetElement>(null);
  const leadRef = useRef<HTMLButtonElement>(null);
  const membersError = validationError === "members";

  useEffect(() => {
    if (!open) return;
    setName(team?.name ?? "");
    setMemberIds(team?.memberAgentIds ?? []);
    setLeadId(team?.leadAgentId ?? "");
    setValidationError(null);
  }, [open, team?.id]);

  const { agents: employeeAgents } = useEmployeeAgents(open ? employeeId : undefined);
  const agents = useMemo(
    () => employeeAgents.filter((agent) => !agent.deletedAt),
    [employeeAgents],
  );
  // The lead must be one of the team's own members, so this picker has a
  // single roster and the shared picker draws no tab strip for it.
  const leadCandidates = useMemo(
    () => agents.filter((agent) => memberIds.includes(agent.id)),
    [agents, memberIds],
  );
  const rosterTabs: RosterTab<"members">[] = [
    { id: "members", label: t("teams.members"), count: leadCandidates.length },
  ];
  const roster = useRosterTabs({ tabs: rosterTabs, activeTab: "members", label: t("teams.lead") });
  const busy = createTeamMutation.isPending || updateTeamMutation.isPending || deleteTeamMutation.isPending;
  const saving = createTeamMutation.isPending || updateTeamMutation.isPending;
  const hasUnsavedChanges = open && (
    name.trim() !== (team?.name ?? "").trim()
    || leadId !== (team?.leadAgentId ?? "")
    || memberIds.length !== (team?.memberAgentIds ?? []).length
    || memberIds.some((id) => !(team?.memberAgentIds ?? []).includes(id))
  );
  const confirmDiscardChanges = useUnsavedChangesGuard(hasUnsavedChanges && !busy);

  async function requestClose() {
    if (busy) return;
    if (await confirmDiscardChanges()) onClose();
  }

  function toggleMember(agentId: string) {
    setValidationError(null);
    setMemberIds((current) => {
      if (current.includes(agentId)) {
        const next = current.filter((id) => id !== agentId);
        if (leadId === agentId) setLeadId(next[0] ?? "");
        return next;
      }
      const next = [...current, agentId];
      if (!leadId) setLeadId(agentId);
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setValidationError("name");
      nameRef.current?.focus();
      return;
    }
    if (memberIds.length === 0) {
      setValidationError("members");
      membersRef.current?.focus();
      return;
    }
    if (!leadId) {
      setValidationError("lead");
      leadRef.current?.focus();
      return;
    }
    setValidationError(null);
    const input = teamMutationInput({
      name,
      leadAgentId: leadId,
      memberAgentIds: memberIds,
      enabled: team?.enabled ?? true,
    });
    try {
      if (team) await updateTeamMutation.mutateAsync({ teamId: team.id, input });
      else await createTeamMutation.mutateAsync(input);
      onClose();
    } catch {
      // The shared mutation error handler keeps the drawer open for correction.
    }
  }

  async function remove() {
    if (!team) return;
    if (!(await confirm({
      title: t("teams.delete_title", { name: team.name }),
      message: t("teams.delete_message", { name: team.name }),
      confirmLabel: t("teams.delete"),
      tone: "danger",
    }))) return;
    try {
      await deleteTeamMutation.mutateAsync(team.id);
      onClose();
    } catch {
      // Error already announced.
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      title={team ? t("teams.edit") : t("teams.add")}
      subtitle={t("teams.drawer_subtitle")}
      width="form"
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
    >
      <form className="adm-form" onSubmit={(event) => void submit(event)} noValidate>
        <Field
          label={t("teams.name")}
          error={validationError === "name" ? t("teams.name_required") : undefined}
          errorId="team-name-error"
        >
          <Input
            ref={nameRef}
            data-modal-initial-focus
            name="team-name"
            autoComplete="off"
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value);
              if (validationError === "name") setValidationError(null);
            }}
            aria-invalid={validationError === "name" || undefined}
            aria-describedby={validationError === "name" ? "team-name-error" : undefined}
          />
        </Field>
        <fieldset
          ref={membersRef}
          className="team-member-fieldset"
          tabIndex={-1}
          aria-invalid={membersError || undefined}
          aria-describedby={membersError ? "team-members-error" : undefined}
        >
          <legend>{t("teams.members")}</legend>
          <div className="team-member-options">
            {agents.map((agent) => {
              const selected = memberIds.includes(agent.id);
              return (
                <TeamMemberOption
                  key={agent.id}
                  agentId={agent.id}
                  displayName={agent.displayName}
                  executorKind={agent.executorKind}
                  placements={agent.placements}
                  selected={selected}
                  onToggle={toggleMember}
                />
              );
            })}
          </div>
          {agents.length === 0 ? <span className="adm-form-hint">{t("teams.no_agents")}</span> : null}
          {membersError ? (
            <FieldError id="team-members-error">{t("teams.members_required")}</FieldError>
          ) : null}
        </fieldset>
        <Field
          label={t("teams.lead")}
          labelId={leadLabelId}
          wrapper="div"
          error={validationError === "lead" ? t("teams.lead_required") : undefined}
          errorId="team-lead-error"
        >
          <Select
            value={leadId}
            disabled={memberIds.length === 0}
            onValueChange={(value) => {
              if (value) setLeadId(value);
              setValidationError(null);
            }}
            onOpenChange={(open) => { if (open) roster.resetTab(); }}
          >
            <SelectTrigger
              ref={leadRef}
              className="w-full"
              aria-labelledby={leadLabelId}
              aria-invalid={validationError === "lead" || undefined}
              aria-describedby={validationError === "lead" ? "team-lead-error" : undefined}
            >
              <SelectValue>
                {(value: string) => {
                  const lead = agents.find((agent) => agent.id === value);
                  return lead ? <RosterTriggerValue agent={lead} /> : value;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              alignItemWithTrigger={false}
              onKeyDownCapture={roster.onKeyDownCapture}
              header={roster.header}
            >
              <SelectGroup aria-label={rosterLabel(rosterTabs, roster.tab)}>
                {leadCandidates.map((agent) => (
                  <RosterAgentItem key={agent.id} value={agent.id} agent={agent} />
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <div className="adm-form-actions">
          {team ? <Button size="cta" type="button" variant="destructive" className="adm-form-actions-leading" onClick={() => void remove()} disabled={busy} loading={deleteTeamMutation.isPending}>{t("teams.delete")}</Button> : null}
          <Button size="cta" type="button" variant="ghost" onClick={() => { void requestClose(); }} disabled={busy}>{t("dialog.cancel")}</Button>
          <Button size="cta" type="submit" loading={saving} disabled={deleteTeamMutation.isPending}>{saving ? t("admin.saving") : team ? t("teams.save") : t("teams.create")}</Button>
        </div>
      </form>
    </Drawer>
  );
}
