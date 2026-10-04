"use client";

import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { agentLabel } from "../lib/plan";
import { MAX_PROJECT_MEMBERS, orderedProjectMembers, projectMemberState } from "../lib/projectPage";
import type { EmployeeAgent, ProjectMember, ProjectRecord } from "../types";
import { AgentStateBadge } from "./AgentStateBadge";
import { ActionAdd, ActionEdit, ICON } from "./icons";
import { LeadBadge } from "./LeadBadge";
import { ProjectMark } from "./ProjectMark";
import { TonePill } from "./StatusPill";
import { WorkspaceEmpty } from "./workspace/WorkspacePrimitives";
import { Button } from "@/components/ui/button";

/** The Members tab: who works in the project, as cards, and the one place
 *  the crew is added to or edited. General shows a summary that links here. */
export function ProjectMembersPanel({
  project,
  agents,
  onAddMember,
  onEditMember,
}: {
  project: ProjectRecord;
  agents: EmployeeAgent[];
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

function ProjectMemberLane({
  member,
  agent,
  index,
  lead,
  onEdit,
}: {
  member: ProjectMember;
  agent?: EmployeeAgent;
  index: number;
  lead: boolean;
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const { available, enabled, availability } = projectMemberState(member, agent);
  const name = agent?.displayName || t("project.member_unavailable");

  return (
    <article
      className={`project-member-tile${lead ? " is-lead" : ""}${available ? "" : " is-missing"}`}
      style={{ "--project-member-index": index } as CSSProperties}
    >
      <header className="project-member-tile-head">
        <AgentStateBadge
          agent={agent?.executorKind}
          ready={enabled && availability === "ready"}
          availability={availability}
          imageUrl={agent?.profileImageUrl}
          name={name}
        />
        <span className="project-member-tile-identity">
          <span className="project-member-tile-name">
            <strong>{name}</strong>
            {lead ? <LeadBadge /> : null}
            {/* The role is a chip beside the name, as on a team member card —
                not the tail of the runtime line. */}
            <TonePill tone="neutral" label={t(`project.roles.${member.role}`)} />
            {!member.enabled ? <TonePill tone="neutral" label={t("project.member_disabled")} /> : null}
            {!available ? <TonePill tone="warn" label={t("project.member_missing")} /> : null}
          </span>
          <span className="project-member-tile-meta">
            {agent ? agentLabel(agent.executorKind) : member.agentId}
          </span>
        </span>
      </header>

      <div className="project-member-tile-body">
        <p className="project-member-tile-responsibilities">
          {member.responsibilities}
        </p>
        {member.instructions ? (
          <div className="project-member-tile-instructions">
            <span>{t("project.instructions_short")}</span>
            <p>{member.instructions}</p>
          </div>
        ) : null}
      </div>

      {onEdit ? (
        <Button variant="ghost"
          type="button"
          className="project-member-tile-edit"
          tooltip={t("project.member_edit_name", { name })}
          onClick={onEdit}
        >
          <ActionEdit size={ICON.sm} aria-hidden="true" />
        </Button>
      ) : null}
    </article>
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
  agentsById: Map<string, EmployeeAgent>;
  onAddMember?: () => void;
  onEditMember?: (member: ProjectMember) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {members.length ? (
        <div className="project-member-tiles">
          {members.map((member, index) => (
            <ProjectMemberLane
              key={member.agentId}
              member={member}
              agent={agentsById.get(member.agentId)}
              index={index}
              lead={member.agentId === project.leadAgentId}
              onEdit={onEditMember ? () => onEditMember(member) : undefined}
            />
          ))}
        </div>
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
