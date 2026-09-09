"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { deleteTeamProfileImage, getWorkspaceBrief, updateTeamProfileImage } from "../api";
import { useEmployeeAgents } from "../hooks/useEmployeeAgents";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { TEAMS_QUERY_KEY } from "../hooks/useTeams";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { teamAvailability } from "../lib/taskAssignment";
import { teamMutationInput } from "../lib/teamForm";
import type { AgentTeam } from "../types";
import {
  ActionEdit,
  AdminDelete,
  ICON,
} from "./icons";
import { AgentMetaLine } from "./AgentMetaLine";
import { AgentStateBadge } from "./AgentStateBadge";
import { PageHeader } from "./PageHeader";
import { IdentityMark } from "./IdentityMark";
import { TeamMemberOption } from "./TeamMemberOption";
import { ProfileImage, ProfileImagePicker } from "./ProfileImagePicker";
import { ActivitiesSkeleton, WorkspaceActivities, WorkspaceError } from "./workspace/WorkspacePrimitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RecordBand, type RecordFact } from "./workspace/RecordBand";
import { StatusPill, TonePill } from "./StatusPill";
import { truncateId } from "../lib/adminHelpers";
import { formatRelativeTime } from "./admin/helpers";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type TeamPageTab = "profile" | "activities";

const TEAM_PAGE_TABS: readonly TeamPageTab[] = ["profile", "activities"];
const TEAM_BRIEF_POLL_MS = 3000;

function parseTeamTab(value: string | null): TeamPageTab {
  return TEAM_PAGE_TABS.includes(value as TeamPageTab) ? value as TeamPageTab : "profile";
}

function TeamProfile({
  team,
  employeeId,
  onDeleted,
}: {
  team: AgentTeam;
  employeeId?: string;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const leadLabelId = useId();
  const { confirm } = useDialogs();
  const queryClient = useQueryClient();
  const { updateTeamMutation, deleteTeamMutation } = useRelayMutations();
  const { agents: employeeAgents } = useEmployeeAgents(employeeId);
  const agents = useMemo(
    () => employeeAgents.filter((agent) => !agent.deletedAt),
    [employeeAgents],
  );
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(team.name);
  const [memberIds, setMemberIds] = useState<string[]>(team.memberAgentIds);
  const [leadId, setLeadId] = useState(team.leadAgentId ?? "");
  const [imageSaving, setImageSaving] = useState(false);
  const [validationError, setValidationError] = useState<
    "members" | "lead" | null
  >(null);
  const membersRef = useRef<HTMLFieldSetElement>(null);
  const leadRef = useRef<HTMLButtonElement>(null);
  const busy = updateTeamMutation.isPending || deleteTeamMutation.isPending
    || imageSaving;
  const draftDirty = leadId !== (team.leadAgentId ?? "")
    || memberIds.length !== team.memberAgentIds.length
    || memberIds.some((id) => !team.memberAgentIds.includes(id));
  const confirmDiscardChanges = useUnsavedChangesGuard(editing && draftDirty && !busy);

  function applyTeamUpdate(updated: AgentTeam) {
    queryClient.setQueriesData<{ teams: AgentTeam[] }>(
      { queryKey: [TEAMS_QUERY_KEY] },
      (current) => current
        ? { teams: current.teams.map((item) => item.id === updated.id ? updated : item) }
        : current,
    );
  }

  async function uploadImage(dataUrl: string) {
    setImageSaving(true);
    try {
      const result = await updateTeamProfileImage(team.id, dataUrl);
      applyTeamUpdate(result.team);
    } finally {
      setImageSaving(false);
    }
  }

  async function removeImage() {
    setImageSaving(true);
    try {
      const result = await deleteTeamProfileImage(team.id);
      applyTeamUpdate(result.team);
    } finally {
      setImageSaving(false);
    }
  }

  function resetDraft() {
    setMemberIds(team.memberAgentIds);
    setLeadId(team.leadAgentId ?? "");
    setValidationError(null);
  }

  function startRename() {
    setNameDraft(team.name);
    setRenaming(true);
  }

  async function saveRename() {
    const next = nameDraft.trim();
    if (!next) return;
    if (next === team.name.trim()) {
      setRenaming(false);
      return;
    }
    try {
      await updateTeamMutation.mutateAsync({
        teamId: team.id,
        input: teamMutationInput({
          name: next,
          memberAgentIds: team.memberAgentIds,
          leadAgentId: team.leadAgentId ?? "",
          enabled: team.enabled,
        }),
      });
      setRenaming(false);
    } catch {
      // The shared mutation handler announces the error and keeps the draft open.
    }
  }

  function startEditing() {
    resetDraft();
    setEditing(true);
  }

  async function cancelEditing() {
    if (!(await confirmDiscardChanges())) return;
    resetDraft();
    setEditing(false);
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

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    try {
      await updateTeamMutation.mutateAsync({
        teamId: team.id,
        input: teamMutationInput({
          name: team.name,
          memberAgentIds: memberIds,
          leadAgentId: leadId,
          enabled: team.enabled,
        }),
      });
      setEditing(false);
    } catch {
      // The shared mutation handler announces the error and leaves the form editable.
    }
  }

  async function remove() {
    if (!(await confirm({
      title: t("teams.delete_title", { name: team.name }),
      message: t("teams.delete_message", { name: team.name }),
      confirmLabel: t("teams.delete"),
      tone: "danger",
    }))) return;
    try {
      await deleteTeamMutation.mutateAsync(team.id);
      onDeleted();
    } catch {
      // The shared mutation handler announces the error and keeps the profile open.
    }
  }

  return (
    <div className="workspace-profile">
      {/* Same dossier grammar as the agent record: a document column holding
          the thing you can change (the roster), an identity rail beside it,
          and record-wide management below both. Facts that only name the
          record (status, member count, id) live in the RecordBand above.

          Unlike the agent record, a team's document is a roster — a few rows,
          not an instructions essay — so the grid is stretched to the pane and
          management is anchored at its foot. Left to size to content, the
          panel ended a third of the way down and the rest of the surface was
          dead space with a Danger zone floating in the middle of it. */}
      <div className="workspace-profile-panel workspace-profile-dossier">
        <div className="workspace-dossier-doc">
          <form className="team-profile-inline-form" onSubmit={(event) => void save(event)}>
            <section aria-labelledby="team-profile-members">
              <div className="team-profile-section-head">
                <h2 id="team-profile-members" className="workspace-dossier-section-title">
                  {t("teams.members")}
                  {/* Count rides the label it counts. Parked on the far right
                      beside the pencil it was a numeral with no subject. */}
                  <span className="tnum">{editing ? memberIds.length : team.members.length}</span>
                </h2>
                <span className="team-profile-section-head-side">
                  {!editing ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="workspace-dossier-icon-btn"
                      tooltip={t("teams.edit_members")}
                      onClick={startEditing}
                    >
                      <ActionEdit size={ICON.sm} aria-hidden="true" />
                    </Button>
                  ) : null}
                </span>
              </div>
              {editing ? (
                <fieldset
                  ref={membersRef}
                  className="team-profile-member-fieldset"
                  aria-label={t("teams.members")}
                  tabIndex={-1}
                  aria-invalid={validationError && validationError !== "lead" ? true : undefined}
                  aria-describedby={validationError && validationError !== "lead" ? "team-profile-members-error" : undefined}
                >
                  <div className="team-member-options team-profile-member-options">
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
                          disabled={busy}
                          onToggle={toggleMember}
                        />
                      );
                    })}
                  </div>
                  {agents.length === 0 ? <span className="adm-form-hint">{t("teams.no_agents")}</span> : null}
                  {validationError && validationError !== "lead" ? (
                    <span id="team-profile-members-error" className="text-sm text-danger" role="alert">
                      {t("teams.members_required")}
                    </span>
                  ) : null}
                </fieldset>
              ) : (
                <ul className="team-profile-members">
                  {team.members.map((member) => {
                    const ready = member.enabled && member.availability === "ready";
                    // TeamMemberSummary carries no placements; the roster's
                    // full agent record knows the member's computers.
                    const placements = agents.find((agent) => agent.id === member.id)?.placements ?? [];
                    return (
                      <li key={member.id} className="team-profile-member">
                        <AgentStateBadge
                          agent={member.executorKind}
                          ready={ready}
                          availability={member.enabled ? member.availability : undefined}
                          imageUrl={member.profileImageUrl}
                          name={member.displayName}
                        />
                        <span className="team-profile-member-copy">
                          <span className="team-profile-member-title">
                            <strong>{member.displayName}</strong>
                            {member.id === team.leadAgentId ? (
                              <span className="team-profile-member-lead">{t("teams.lead_badge")}</span>
                            ) : null}
                          </span>
                          <AgentMetaLine
                            executorKind={member.executorKind}
                            placements={placements}
                            className="team-profile-member-meta"
                          />
                        </span>
                        {/* Per-member readiness, not the team's — the band
                            carries the team's own availability. */}
                        <span className="team-profile-member-state">
                          {!member.enabled
                            ? <TonePill tone="neutral" label={t("teams.disabled")} />
                            : member.availability !== "ready"
                              ? <StatusPill value={member.availability} />
                              : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {editing ? (
              <>
                <Field
                  label={t("teams.lead")}
                  labelId={leadLabelId}
                  wrapper="div"
                  className="team-profile-lead-field"
                  error={validationError === "lead" ? t("teams.lead_required") : undefined}
                  errorId="team-profile-lead-error"
                >
                  <Select value={leadId} disabled={busy || memberIds.length === 0} onValueChange={(value) => {
                    if (value) setLeadId(value);
                    setValidationError(null);
                  }}>
                    <SelectTrigger
                      ref={leadRef}
                      className="w-full"
                      aria-labelledby={leadLabelId}
                      aria-invalid={validationError === "lead" || undefined}
                      aria-describedby={validationError === "lead" ? "team-profile-lead-error" : undefined}
                    >
                      <SelectValue>
                        {(value: string) => agents.find((agent) => agent.id === value)?.displayName ?? value}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {agents.filter((agent) => memberIds.includes(agent.id)).map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>{agent.displayName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="team-profile-inline-actions">
                  <span className="team-profile-inline-actions-spacer" />
                  <Button type="button" variant="ghost" onClick={() => void cancelEditing()} disabled={busy}>
                    {t("dialog.cancel")}
                  </Button>
                  <Button type="submit" loading={updateTeamMutation.isPending} loadingLabel={t("admin.saving")} disabled={deleteTeamMutation.isPending || imageSaving}>
                    {t("teams.save")}
                  </Button>
                </div>
              </>
            ) : null}
          </form>
        </div>

        <aside className="workspace-dossier-rail" aria-label={t("workspace.identity_label")}>
          <div className="workspace-dossier-portrait">
            <ProfileImagePicker
              imageUrl={team.profileImageUrl}
              name={team.name}
              fallback={<IdentityMark kind="team" />}
              editable
              disabled={busy}
              onUpload={uploadImage}
              onRemove={removeImage}
            />
          </div>

          <div className="workspace-dossier-field">
            <span className="workspace-dossier-field-label">{t("teams.name")}</span>
            {renaming ? (
              <div className="workspace-dossier-rename">
                <Input
                  name="team-name"
                  type="text"
                  aria-label={t("teams.name")}
                  autoComplete="off"
                  autoFocus
                  required
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveRename();
                    if (event.key === "Escape") setRenaming(false);
                  }}
                  disabled={busy}
                />
                <div className="workspace-dossier-rename-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="dense"
                    onClick={() => setRenaming(false)}
                    disabled={busy}
                  >
                    {t("dialog.cancel")}
                  </Button>
                  <Button
                    type="button"
                    size="dense"
                    onClick={() => void saveRename()}
                    disabled={busy}
                  >
                    {t("teams.save")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="workspace-dossier-name-row">
                <span className="workspace-dossier-name-value" translate="no">{team.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  className="workspace-dossier-icon-btn"
                  tooltip={t("teams.rename")}
                  onClick={startRename}
                >
                  <ActionEdit size={ICON.sm} aria-hidden="true" />
                </Button>
              </div>
            )}
          </div>

          {/* Created/updated moved to the band — the rail holds only the
              things you can change. */}
        </aside>

        {/* Management spans both columns — it acts on the whole record, not
            on the roster document or the identity rail. Hidden while the
            roster is open: a live Delete directly under Save is the wrong
            thing to put next to the save target. */}
        {!editing ? (
          <div className="workspace-dossier-admin">
            <section className="adm-drawer-section" aria-labelledby="team-profile-danger-title">
              <p id="team-profile-danger-title" className="workspace-dossier-section-title">
                {t("admin.v2.danger_zone")}
              </p>
              <Button type="button" variant="destructive" onClick={() => void remove()} loading={deleteTeamMutation.isPending} loadingLabel={t("teams.deleting")} disabled={updateTeamMutation.isPending || imageSaving}>
                <AdminDelete size={ICON.sm} aria-hidden="true" />
                {t("teams.delete")}
              </Button>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TeamWorkspacePage({
  team,
  employeeId,
  onOpenThread,
  onDeleted,
}: {
  team: AgentTeam;
  employeeId?: string;
  onOpenThread: (sessionId: string) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [pageTab, setPageTab] = useUrlSearchState("tab", "profile" as TeamPageTab, parseTeamTab, (value) => value === "profile" ? null : value, "push");
  const briefQuery = useQuery({
    queryKey: ["team-workspace-brief", team.id],
    queryFn: ({ signal }) => getWorkspaceBrief({ teamId: team.id }, signal),
    enabled: pageTab !== "profile",
    refetchInterval: pageTab === "activities" ? TEAM_BRIEF_POLL_MS : false,
  });
  /* The band is the record's read-only spine, identical on both tabs —
     the same rule the agent record follows: facts live here and no tab panel
     may restate them. Every field comes off the team record itself.

     Member count and lead are deliberately NOT here: the roster on the
     profile tab already names every member and marks the lead, so a band
     cell would be the same fact one row higher. The timestamps take those
     slots instead — they are read-only record coordinates, which is exactly
     what the band is for, and the rail is reserved for editable things. */
  const bandFacts: RecordFact[] = [
    {
      key: "availability",
      label: t("admin.v2.agent_availability_label"),
      value: !team.enabled
        ? <TonePill tone="neutral" label={t("teams.disabled")} />
        : <StatusPill value={teamAvailability(team)} />,
    },
    {
      key: "created",
      label: t("workspace.band_created"),
      value: formatRelativeTime(team.createdAt, t),
    },
    {
      key: "updated",
      label: t("workspace.band_updated"),
      value: formatRelativeTime(team.updatedAt, t),
    },
    {
      key: "id",
      label: t("workspace.band_team_id"),
      value: truncateId(team.id),
      technical: true,
      title: team.id,
    },
  ];

  const error = briefQuery.error instanceof Error ? briefQuery.error.message : briefQuery.error ? String(briefQuery.error) : "";
  return (
    <Tabs
      render={<section />}
      className="workspace-page team-workspace-page"
      aria-label={t("teams.profile_title", { name: team.name })}
      value={pageTab}
      onValueChange={(value) => setPageTab(value as TeamPageTab)}
    >
      <PageHeader
        kicker={t("nav.workforce")}
        title={(
          <span className="workspace-header-title">
            <span className="workspace-header-mark" aria-hidden="true">
              <ProfileImage
                src={team.profileImageUrl}
                alt=""
                fallback={<IdentityMark kind="team" />}
              />
            </span>
            {team.name}
          </span>
        )}
        titleVariant="record"
        titleAs="h2"
        layout="stacked"
        toolbar={(
          <TabsList className="workspace-page-tabs" aria-label={t("teams.sections")}>
            {TEAM_PAGE_TABS.map((tab) => (
              <TabsTrigger
                key={tab}
                value={tab}
                className={`workspace-page-tab${pageTab === tab ? " is-active" : ""}`}
              >
                {tab === "profile" ? t("workspace.tab_profile") : t("workspace.tab_activities")}
                {tab === "activities" && briefQuery.data?.metrics.sessionCount ? <span className="workspace-page-tab-count tnum">{briefQuery.data.metrics.sessionCount}</span> : null}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
      />
      <RecordBand facts={bandFacts} label={t("workspace.band_team_label")} />

      {/* One body shell for both tabs, matching the agent record — it
          owns the container query the profile dossier grid reads. */}
      <div className="workspace-body">
        <TabsContent value="profile">
          <TeamProfile team={team} employeeId={employeeId} onDeleted={onDeleted} />
        </TabsContent>
        <TabsContent value="activities">
          {briefQuery.isLoading && !briefQuery.data ? (
            <ActivitiesSkeleton />
          ) : error || !briefQuery.data ? (
            <WorkspaceError
              message={error || t("workspace.load_failed")}
              onRetry={() => void briefQuery.refetch()}
            />
          ) : (
            <WorkspaceActivities
              brief={briefQuery.data}
              emptyMark={<IdentityMark kind="team" variant="bare" size={ICON.lg} />}
              onOpenThread={onOpenThread}
            />
          )}
        </TabsContent>
      </div>
    </Tabs>
  );
}
