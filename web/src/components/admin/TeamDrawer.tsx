"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useEmployeeAgents } from "../../hooks/useEmployeeAgents";
import { useComputerOptions } from "../../hooks/useComputerOptions";
import {
  agentsForTeamComputer,
  membersOffComputer,
  pruneMembershipToComputer,
  teamComputerId,
} from "../../lib/teamComputer";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { teamContractChanged, teamMutationInput } from "../../lib/teamForm";
import { randomPresetAvatar } from "../../lib/presetAvatars";
import { PresetAvatarGrid } from "../PresetAvatarGrid";
import type { AgentTeam, TeamMemberConfig } from "../../types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Drawer } from "@/components/ui/Drawer";
import { TeamMemberPicker, type TeamMembership } from "../TeamMemberPicker";
import { ComputerSelect } from "../ComputerSelect";
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
  const avatarLabelId = useId();
  const computerLabelId = useId();
  const { confirm } = useDialogs();
  const { createTeamMutation, updateTeamMutation, deleteTeamMutation } = useRelayMutations();
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [memberConfigs, setMemberConfigs] = useState<Record<string, TeamMemberConfig>>({});
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<string[]>([]);
  const [leadId, setLeadId] = useState("");
  const [profileImageUrl, setProfileImageUrl] = useState(() => randomPresetAvatar("teams"));
  // Null until the user picks: the computer then follows the team record, or
  // the only computer the employee has.
  const [computerPick, setComputerPick] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<"name" | "computer" | "members" | "off_computer" | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const computerRef = useRef<HTMLButtonElement>(null);
  const membersRef = useRef<HTMLFieldSetElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(team?.name ?? "");
    setMemberIds(team?.memberAgentIds ?? []);
    setLeadId(team?.leadAgentId ?? "");
    setMemberConfigs(team?.memberConfigs ?? {});
    setAcceptanceCriteria(team?.acceptanceCriteria ?? []);
    setProfileImageUrl(randomPresetAvatar("teams"));
    setComputerPick(null);
    setValidationError(null);
  }, [open, team?.id]);

  const { agents: employeeAgents } = useEmployeeAgents(open ? employeeId : undefined);
  const agents = useMemo(
    () => employeeAgents.filter((agent) => !agent.deletedAt),
    [employeeAgents],
  );
  const computers = useComputerOptions(employeeId ?? "", open && Boolean(employeeId));
  // A team lives on one computer: it is chosen first, and the member picker
  // only offers the agents placed on it.
  const savedComputerId = team ? teamComputerId(team, agents) : "";
  const computerId = computerPick
    ?? (savedComputerId || (computers.options.length === 1 ? computers.options[0].computerId : ""));
  const computerAgents = useMemo(
    () => agentsForTeamComputer(agents, computerId, memberIds),
    [agents, computerId, memberIds],
  );
  const busy = createTeamMutation.isPending || updateTeamMutation.isPending || deleteTeamMutation.isPending;
  const saving = createTeamMutation.isPending || updateTeamMutation.isPending;
  const hasUnsavedChanges = open && (
    teamContractChanged({ memberConfigs, acceptanceCriteria }, team ?? {}, memberIds)
    || name.trim() !== (team?.name ?? "").trim()
    || (computerPick !== null && computerPick !== savedComputerId)
    || leadId !== (team?.leadAgentId ?? "")
    || memberIds.length !== (team?.memberAgentIds ?? []).length
    || memberIds.some((id) => !(team?.memberAgentIds ?? []).includes(id))
  );
  const confirmDiscardChanges = useUnsavedChangesGuard(hasUnsavedChanges && !busy);

  async function requestClose() {
    if (busy) return;
    if (await confirmDiscardChanges()) onClose();
  }

  function changeComputer(next: string) {
    setValidationError(null);
    setComputerPick(next);
    changeMembership(pruneMembershipToComputer({ memberIds, leadId }, agents, next));
  }

  function changeMembership(next: TeamMembership) {
    setValidationError(null);
    setMemberIds(next.memberIds);
    setLeadId(next.leadId);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!computerId) {
      setValidationError("computer");
      computerRef.current?.focus();
      return;
    }
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
    if (membersOffComputer(agents, computerId, memberIds).length > 0) {
      setValidationError("off_computer");
      membersRef.current?.focus();
      return;
    }
    setValidationError(null);
    const input = teamMutationInput({
      name,
      leadAgentId: leadId,
      memberAgentIds: memberIds,
      computerId,
      memberConfigs, acceptanceCriteria,
      enabled: team?.enabled ?? true,
    });
    try {
      // The image of an existing team is changed from its own page, where an
      // upload is also possible; this drawer only picks one at creation.
      if (team) await updateTeamMutation.mutateAsync({ teamId: team.id, input });
      else await createTeamMutation.mutateAsync({ ...input, profileImageUrl });
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
          label={t("teams.computer")}
          labelId={computerLabelId}
          wrapper="div"
          hint={t("teams.computer_hint")}
          error={validationError === "computer" ? t("teams.computer_required") : undefined}
          errorId="team-computer-error"
        >
          <ComputerSelect
            ref={computerRef}
            initialFocus
            options={computers.options}
            value={computerId}
            onChange={changeComputer}
            placeholder={computers.isLoading ? t("admin.loading") : t("teams.computer_placeholder")}
            disabled={busy || computers.isLoading || computers.options.length === 0}
            labelledBy={computerLabelId}
            error={validationError === "computer"}
            errorId="team-computer-error"
          />
        </Field>
        <Field
          label={t("teams.name")}
          error={validationError === "name" ? t("teams.name_required") : undefined}
          errorId="team-name-error"
        >
          <Input
            ref={nameRef}
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
        {team ? null : (
          <Field label={t("teams.avatar")} labelId={avatarLabelId} wrapper="div">
            <PresetAvatarGrid
              kind="teams"
              value={profileImageUrl}
              onChange={setProfileImageUrl}
              labelledBy={avatarLabelId}
              disabled={busy}
            />
          </Field>
        )}
        <TeamMemberPicker
          ref={membersRef}
          agents={computerAgents}
          value={{ memberIds, leadId }}
          onChange={changeMembership}
          disabled={busy || !computerId}
          error={validationError === "members"
            ? t("teams.members_required")
            : validationError === "off_computer"
            ? t("teams.members_off_computer")
            : undefined}
          errorId="team-members-error"
          emptyHint={computerId ? t("teams.computer_no_agents") : t("teams.members_choose_computer")}
        />
        <Field label={t("team_work.criteria")} hint={t("team_work.one_per_line")}>
          <Textarea
            rows={3}
            value={acceptanceCriteria.join("\n")}
            disabled={busy}
            onChange={(event) => setAcceptanceCriteria(event.target.value.split("\n"))}
          />
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
