"use client";

import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AgentName, AgentPlacement, LogicalAgentAvailability, TeamMemberConfig } from "../types";
import { AgentMetaLine } from "./AgentMetaLine";
import { AgentStateBadge } from "./AgentStateBadge";
import { LeadBadge } from "./LeadBadge";
import { TonePill } from "./StatusPill";
import { ActionEdit, ICON } from "./icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ROLES = ["inherit", "planner", "implementer", "tester", "reviewer", "fixer"] as const;

export type TeamCardMember = {
  id: string;
  displayName: string;
  executorKind: AgentName;
  profileImageUrl?: string | null;
  enabled?: boolean;
  availability?: LogicalAgentAvailability;
  defaultRole?: string;
  placements?: AgentPlacement[];
};

function effectiveRoleOf(member: TeamCardMember, config: TeamMemberConfig) {
  return config.role ?? member.defaultRole;
}

/** Required unless on-request; an unset flag falls back to the team default,
 *  where every always-participating member's contribution gates completion. */
function isRequired(config: TeamMemberConfig) {
  if (config.participation === "on_request") return false;
  return config.required ?? true;
}

/* Who the member is: avatar with readiness pip; name with the role they will
   actually play (so an inherited role is visible without opening the select)
   and the lead star; then the shared <AgentMetaLine> — runtime glyph and the
   computers it runs on, the one meta line every agent surface renders. Same
   head grammar as the project crew tiles. */
function TeamMemberCardHead({ member, config, lead, nameId, side }: {
  member: TeamCardMember;
  config: TeamMemberConfig;
  lead: boolean;
  nameId: string;
  side?: ReactNode;
}) {
  const { t } = useTranslation();
  const role = effectiveRoleOf(member, config);
  const availability = member.enabled === false ? "offline" : member.availability;
  return (
    <header className="team-work-member-head">
      <AgentStateBadge
        agent={member.executorKind}
        ready={availability === "ready"}
        availability={availability}
        imageUrl={member.profileImageUrl}
        name={member.displayName}
      />
      <span className="team-work-member-identity">
        <span className="team-work-member-name">
          <strong id={nameId}>{member.displayName}</strong>
          {lead ? <LeadBadge /> : null}
          {role ? <TonePill tone="neutral" label={t(`team_work.role_${role}`)} /> : null}
          {member.enabled === false ? <TonePill tone="neutral" label={t("teams.disabled")} /> : null}
        </span>
        <AgentMetaLine executorKind={member.executorKind} placements={member.placements ?? []} />
      </span>
      {side}
    </header>
  );
}

/* The contract controls, shown when a card opens for inline edit. Every
   control is a <Field> so the label voice matches the surrounding form; the flags are the <Checkbox> primitive, never a native
   checkbox. The wrapping <label> is the whole accessible name on each flag:
   base-ui already points the control's aria-labelledby at it, so an aria-label
   repeating the same copy would announce twice. */
function TeamMemberContractFields({ member, config, lead, idBase, disabled, onChange }: {
  member: TeamCardMember;
  config: TeamMemberConfig;
  lead: boolean;
  idBase: string;
  disabled?: boolean;
  onChange: (next: TeamMemberConfig) => void;
}) {
  const { t } = useTranslation();
  const update = (patch: Partial<TeamMemberConfig>) => onChange({ ...config, ...patch });
  const onRequest = config.participation === "on_request";
  return (
    <>
      <Field label={t("team_work.role")} labelId={`${idBase}-role`} wrapper="div">
        <Select
          value={config.role ?? "inherit"}
          disabled={disabled}
          onValueChange={(value) => {
            if (value) {
              update({ role: value === "inherit" ? undefined : (value as TeamMemberConfig["role"]) });
            }
          }}
        >
          <SelectTrigger className="w-full" aria-labelledby={`${idBase}-role`}>
            {/* A bare <SelectValue/> renders the stored value ("inherit"),
                not the role's copy. */}
            <SelectValue>{(value: string) => t(`team_work.role_${value}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((role) => (
              <SelectItem key={role} value={role}>{t(`team_work.role_${role}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("team_work.responsibility")}>
        <Textarea
          rows={2}
          value={config.responsibility ?? ""}
          maxLength={4000}
          placeholder={t("team_work.scope_example")}
          onChange={(event) => update({ responsibility: event.target.value })}
        />
      </Field>
      <Field label={t("team_work.outputs")} hint={t("team_work.one_per_line")}>
        <Textarea
          rows={2}
          value={(config.expectedOutputs ?? []).join("\n")}
          onChange={(event) => update({ expectedOutputs: event.target.value.split("\n") })}
        />
      </Field>
      {lead ? null : (
        <div className="team-work-flags">
          <label className="team-work-flag">
            <Checkbox
              checked={onRequest}
              disabled={disabled}
              onCheckedChange={(value) => update({
                participation: value === true ? "on_request" : "always",
                // Clearing it (rather than pinning false) hands the member
                // back to the team default when the flag is unset.
                required: value === true ? false : undefined,
              })}
            />
            <span>{t("team_work.on_request")}</span>
          </label>
          <label className="team-work-flag">
            <Checkbox
              checked={isRequired(config)}
              disabled={onRequest || disabled}
              onCheckedChange={(value) => update({ required: value === true })}
            />
            <span>{t("team_work.required")}</span>
          </label>
        </div>
      )}
    </>
  );
}

/* The read card: what the member owns, how they take part. */
function TeamMemberSummary({ member, config, lead }: {
  member: TeamCardMember;
  config: TeamMemberConfig;
  lead: boolean;
}) {
  const { t } = useTranslation();
  const outputs = (config.expectedOutputs ?? []).map((value) => value.trim()).filter(Boolean);
  const participation = lead
    ? null
    : config.participation === "on_request"
      ? t("team_work.on_request")
      : isRequired(config)
        ? t("team_work.required")
        : t("team_work.optional");
  return (
    <div className="team-work-member-body">
      {config.responsibility?.trim() ? (
        <p className="team-work-member-responsibility">{config.responsibility}</p>
      ) : (
        <p className="team-work-member-responsibility is-empty">{t("team_work.no_responsibility")}</p>
      )}
      {outputs.length ? (
        <div className="team-work-member-outputs">
          <span>{t("team_work.outputs")}</span>
          <ul>{outputs.map((output, index) => <li key={index}>{output}</li>)}</ul>
        </div>
      ) : null}
      {participation ? <p className="team-work-member-participation">{participation}</p> : null}
    </div>
  );
}

/** A member card that reads as a summary and edits in place: the pencil turns
 *  this one card into its contract form, saved or cancelled on its own. */
export function TeamMemberCard({ member, config, lead, canEdit, saving, onEditingChange, onSave }: {
  member: TeamCardMember;
  config: TeamMemberConfig;
  lead: boolean;
  /** False while another card is open or the team is saving elsewhere. */
  canEdit: boolean;
  saving?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onSave: (next: TeamMemberConfig) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const idBase = useId();
  const [draft, setDraft] = useState<TeamMemberConfig | null>(null);
  const editing = draft !== null;

  function setEditing(next: TeamMemberConfig | null) {
    setDraft(next);
    onEditingChange?.(next !== null);
  }

  async function save() {
    if (!draft) return;
    if (await onSave(draft)) setEditing(null);
  }

  const editButton = editing ? null : (
    <Button
      type="button"
      variant="ghost"
      className="team-work-member-edit"
      tooltip={t("team_work.edit_member", { name: member.displayName })}
      disabled={!canEdit}
      onClick={() => setEditing({ ...config })}
    >
      <ActionEdit size={ICON.sm} aria-hidden="true" />
    </Button>
  );

  return (
    <article
      className="team-work-member"
      data-editing={editing || undefined}
      role="group"
      aria-labelledby={`${idBase}-name`}
    >
      <TeamMemberCardHead
        member={member}
        config={draft ?? config}
        lead={lead}
        nameId={`${idBase}-name`}
        side={editButton}
      />
      {editing ? (
        <>
          <TeamMemberContractFields
            member={member}
            config={draft}
            lead={lead}
            idBase={idBase}
            disabled={saving}
            onChange={setDraft}
          />
          <div className="team-work-member-actions">
            <Button type="button" variant="ghost" disabled={saving} onClick={() => setEditing(null)}>
              {t("dialog.cancel")}
            </Button>
            <Button type="button" loading={saving} loadingLabel={t("admin.saving")} onClick={() => void save()}>
              {t("team_work.save_member")}
            </Button>
          </div>
        </>
      ) : (
        <TeamMemberSummary member={member} config={config} lead={lead} />
      )}
    </article>
  );
}
