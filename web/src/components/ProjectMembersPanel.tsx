"use client";

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { projectMemberRole } from "../lib/agentRoleLabel";
import { MAX_PROJECT_MEMBERS, orderedProjectMembers, projectMemberState } from "../lib/projectPage";
import type { UserAgent, ProjectMember, ProjectListItem, ProjectMemberSummary } from "../types";
import { AgentStateBadge } from "./AgentStateBadge";
import { ActionAdd, ICON, RowOpen } from "./icons";
import { LeadBadge } from "./LeadBadge";
import { AgentRoleMeta } from "./RoleLevelBadge";
import { ProjectMark } from "./ProjectMark";
import { TonePill } from "./StatusPill";
import { WorkspaceEmpty } from "./workspace/WorkspacePrimitives";
import { Button } from "@/components/ui/button";

/** The Agents tab: who works in the project, as one list, and the one place
 *  the crew is added to or edited. */
export function ProjectMembersPanel({
  project,
  agents,
  onAddMember,
  onEditMember,
  detailStatus,
  children,
}: {
  project: ProjectListItem;
  agents: UserAgent[];
  onAddMember?: () => void;
  onEditMember?: (member: ProjectMember) => void;
  detailStatus?: ReactNode;
  /** Sections that follow the crew in the same gutter (the workflows). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const members = useMemo(() => orderedProjectMembers(project), [project]);
  const canAdd = Boolean(onAddMember) && members.length > 0 && members.length < MAX_PROJECT_MEMBERS;

  return (
    <div className="project-profile project-members">
      {/* Crew and workflows share one grid: stacked on a narrow pane, the
          crew a side column beside the workflows once the pane is wide. */}
      <div className="project-collab">
        <section className="project-general-section project-crew" aria-labelledby="project-members-title">
          <div className="project-general-section-head">
            <h2 id="project-members-title" className="workspace-dossier-section-title">
              {t("project.members")}
              <span className="tnum">{members.length}</span>
            </h2>
            {canAdd ? (
              <Button type="button" variant="outline" size="dense" onClick={onAddMember}>
                <ActionAdd size={ICON.sm} aria-hidden="true" />
                {t("project.member_add")}
              </Button>
            ) : null}
          </div>
          {detailStatus}
          <ProjectCrew
            project={project}
            members={members}
            agentsById={agentsById}
            onAddMember={onAddMember}
            onEditMember={onEditMember}
          />
        </section>
        {children}
      </div>
    </div>
  );
}

/** One Agent as one row: name, lead mark, role, level, and responsibility. An
 *  exceptional state — disabled, unavailable — earns a pill. Instructions
 *  live in the editor; the whole row opens it. */
function ProjectMemberRow({
  member,
  agent,
  lead,
  onEdit,
}: {
  member: ProjectMemberSummary;
  agent?: UserAgent;
  lead: boolean;
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const { available, enabled, availability } = projectMemberState(member, agent);
  const name = agent?.displayName || t("project.member_unavailable");
  const roleIdentity = projectMemberRole(agent, member);
  const state = !available
    ? <TonePill tone="warn" label={t("project.member_missing")} />
    : !member.enabled ? <TonePill tone="neutral" label={t("project.member_disabled")} /> : null;
  const content = (
    <>
      <AgentStateBadge
        agent={agent?.executorKind}
        ready={enabled && availability === "ready"}
        availability={availability}
        imageUrl={agent?.profileImageUrl}
        name={name}
      />
      <span className="project-member-row-main">
        <span className="project-member-row-name">
          <strong>{name}</strong>
          {lead ? <LeadBadge /> : null}
        </span>
        <AgentRoleMeta identity={roleIdentity} className="project-member-row-meta" />
        {"responsibilities" in member && typeof member.responsibilities === "string" && member.responsibilities ? (
          <span className="project-member-row-duty">{member.responsibilities}</span>
        ) : null}
      </span>
      {/* Always present, so every row's chevron sits in the same column. */}
      <span className="project-member-row-state">{state}</span>
    </>
  );
  const className = `project-member-row${enabled && available ? "" : " is-muted"}`;
  return (
    <li>
      {onEdit ? (
        <button type="button" className={className} aria-label={t("project.member_edit_name", { name })} onClick={onEdit}>
          {content}
          <RowOpen className="project-member-row-open" size={ICON.sm} aria-hidden="true" />
        </button>
      ) : (
        <div className={className}>{content}</div>
      )}
    </li>
  );
}

function ProjectCrew({
  project,
  members,
  agentsById,
  onAddMember,
  onEditMember,
}: {
  project: ProjectListItem;
  members: (ProjectMember | ProjectMemberSummary)[];
  agentsById: Map<string, UserAgent>;
  onAddMember?: () => void;
  onEditMember?: (member: ProjectMember) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {members.length ? (
        <ul className="project-member-list">
          {members.map((member) => (
            <ProjectMemberRow
              key={member.agentId}
              member={member}
              agent={agentsById.get(member.agentId)}
              lead={member.agentId === project.leadAgentId}
              onEdit={onEditMember && "responsibilities" in member ? () => onEditMember(member) : undefined}
            />
          ))}
        </ul>
      ) : (
        <div className="project-profile-empty">
          <WorkspaceEmpty
            title={t("project.profile_empty")}
            hint={t("project.profile_empty_hint")}
            mark={<ProjectMark />}
          />
          {onAddMember ? (
            <div className="project-profile-empty-action">
              <Button type="button" variant="outline" size="dense" onClick={onAddMember}>
                <ActionAdd size={ICON.sm} aria-hidden="true" />
                {t("project.member_add")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
