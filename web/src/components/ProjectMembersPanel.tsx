"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { agentLabel } from "../lib/plan";
import { MAX_PROJECT_MEMBERS, orderedProjectMembers, projectMemberState } from "../lib/projectPage";
import type { UserAgent, ProjectMember, ProjectRecord } from "../types";
import { AgentStateBadge } from "./AgentStateBadge";
import { ActionAdd, ICON, RowOpen } from "./icons";
import { LeadBadge } from "./LeadBadge";
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
}: {
  project: ProjectRecord;
  agents: UserAgent[];
  onAddMember?: () => void;
  onEditMember?: (member: ProjectMember) => void;
}) {
  const { t } = useTranslation();
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const members = useMemo(() => orderedProjectMembers(project), [project]);
  const canAdd = Boolean(onAddMember) && members.length > 0 && members.length < MAX_PROJECT_MEMBERS;

  return (
    <div className="project-profile project-members">
      <section className="project-general-section" aria-labelledby="project-members-title">
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
        <ProjectCrew
          project={project}
          members={members}
          agentsById={agentsById}
          onAddMember={onAddMember}
          onEditMember={onEditMember}
        />
      </section>
    </div>
  );
}

/** One agent as one row: who (name, lead mark), what they are (role,
 *  runtime) on one quiet line, and what they own. Only an
 *  exceptional state — disabled, unavailable — earns a pill. Instructions
 *  live in the editor; the whole row opens it. */
function ProjectMemberRow({
  member,
  agent,
  lead,
  onEdit,
}: {
  member: ProjectMember;
  agent?: UserAgent;
  lead: boolean;
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const { available, enabled, availability } = projectMemberState(member, agent);
  const name = agent?.displayName || t("project.member_unavailable");
  const meta = [
    t(`project.roles.${member.role}`),
    agent ? agentLabel(agent.executorKind) : null,
  ].filter(Boolean).join(" · ");
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
        <span className="project-member-row-meta">{meta}</span>
        {member.responsibilities ? (
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
  project: ProjectRecord;
  members: ProjectMember[];
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
              onEdit={onEditMember ? () => onEditMember(member) : undefined}
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
