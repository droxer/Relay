"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useUserAgents } from "../../hooks/useUserAgents";
import { useComputerOptions } from "../../hooks/useComputerOptions";
import {
  agentsForTeamComputer,
  membersOffComputer,
  pruneMembershipToComputer,
} from "../../lib/teamComputer";
import { useRelayMutations } from "../../hooks/useRelayMutations";
import { teamMutationInput } from "../../lib/teamForm";
import { randomPresetAvatar } from "../../lib/presetAvatars";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Drawer } from "@/components/ui/Drawer";
import { TeamMemberPicker, type TeamMembership } from "../TeamMemberPicker";
import { ComputerOptionsFeedback } from "../computer/ComputerOptionsFeedback";
import { ComputerSelect } from "../ComputerSelect";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { useOnOpen } from "@/hooks/useKeyChange";

export function TeamDrawer({
  open,
  userId,
  onClose,
}: {
  open: boolean;
  userId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const computerLabelId = useId();
  const { createTeamMutation } = useRelayMutations();
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<string[]>([]);
  const [leadId, setLeadId] = useState("");
  // Null until the user picks: defaults to the only computer the user has.
  const [computerPick, setComputerPick] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<"name" | "computer" | "members" | "off_computer" | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const computerRef = useRef<HTMLButtonElement>(null);
  const membersRef = useRef<HTMLFieldSetElement>(null);

  useOnOpen(open, () => {
    setName("");
    setMemberIds([]);
    setLeadId("");
    setAcceptanceCriteria([]);
    setComputerPick(null);
    setValidationError(null);
  });

  const { agents: userAgents } = useUserAgents(open ? userId : undefined);
  const agents = useMemo(
    () => userAgents.filter((agent) => !agent.deletedAt),
    [userAgents],
  );
  const computers = useComputerOptions(userId ?? "", open && Boolean(userId));
  // A team lives on one computer: it is chosen first, and the member picker
  // only offers the agents placed on it.
  const computerId = computerPick
    ?? (computers.options.length === 1 ? computers.options[0].computerId : "");
  const computerAgents = useMemo(
    () => agentsForTeamComputer(agents, computerId, memberIds),
    [agents, computerId, memberIds],
  );
  const busy = createTeamMutation.isPending;
  const hasUnsavedChanges = open && (
    name.trim().length > 0
    || computerPick !== null
    || memberIds.length > 0
    || acceptanceCriteria.some((line) => line.trim().length > 0)
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
      acceptanceCriteria,
      enabled: true,
    });
    try {
      await createTeamMutation.mutateAsync({ ...input, profileImageUrl: randomPresetAvatar("teams") });
      onClose();
    } catch {
      // The shared mutation error handler keeps the drawer open for correction.
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      title={t("teams.add")}
      subtitle={t("teams.drawer_subtitle")}
      width="form"
      footer={
        <>
          <Button size="cta" type="button" variant="ghost" onClick={() => { void requestClose(); }} disabled={busy}>{t("dialog.cancel")}</Button>
          <Button size="cta" type="submit" form={formId} loading={busy} disabled={computers.isLoading || computers.options.length === 0}>{busy ? t("admin.saving") : t("teams.create")}</Button>
        </>
      }
    >
      <form id={formId} className="adm-form" onSubmit={(event) => void submit(event)} noValidate>
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
          <ComputerOptionsFeedback {...computers} empty={computers.options.length === 0} />
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
      </form>
    </Drawer>
  );
}
