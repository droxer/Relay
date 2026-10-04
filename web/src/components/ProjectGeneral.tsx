"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../lib/adminHelpers";
import { agentLabel } from "../lib/plan";
import { orderedProjectMembers, projectMemberState } from "../lib/projectPage";
import type { EmployeeAgent, ProjectRecord } from "../types";
import { AgentStateBadge } from "./AgentStateBadge";
import {
  ActionCalendar,
  ActionEdit,
  ActionRetry,
  ICON,
  NavProjects,
  NodeOwnershipIcon,
  WorkspaceFolder,
  type NodeOwnership,
} from "./icons";
import { LeadBadge } from "./LeadBadge";
import { TonePill } from "./StatusPill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/* General is the project at a glance; the crew gets a short roll call here
   and its cards (and every edit) on the Members tab. */
const CREW_SUMMARY_LIMIT = 5;

export type RailComputer = { label: string; ownership: NodeOwnership };

/** The project's identity, beside its crew — the same rail the team record
 *  carries: mark, name, the computer and folder it lives in, and its stamps.
 *  The pencil opens the Settings tab, which owns every edit. */
function ProjectIdentityRail({
  project,
  computer,
  onOpenSettings,
}: {
  project: ProjectRecord;
  computer: RailComputer;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="workspace-dossier-rail" aria-label={t("workspace.identity_label")}>
      <div className="workspace-dossier-portrait">
        <span className="project-rail-mark" aria-hidden="true">
          <NavProjects size={ICON.xl} />
        </span>
      </div>

      <div className="workspace-dossier-field">
        <span className="workspace-dossier-field-label">{t("project.name")}</span>
        <div className="workspace-dossier-name-row">
          <span className="workspace-dossier-name-value" translate="no">{project.name}</span>
          {onOpenSettings ? (
            <Button
              type="button"
              variant="ghost"
              className="workspace-dossier-icon-btn"
              tooltip={t("project.edit")}
              onClick={onOpenSettings}
            >
              <ActionEdit size={ICON.sm} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="workspace-dossier-field">
        <span className="workspace-dossier-field-label">{t("project.computer")}</span>
        <Badge className="max-w-full" title={project.computerId} translate="no">
          <NodeOwnershipIcon ownership={computer.ownership} size={ICON.xs} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{computer.label}</span>
        </Badge>
      </div>

      {project.workspaceSubpath ? (
        <div className="workspace-dossier-field">
          <span className="workspace-dossier-field-label">{t("project.shared_workspace")}</span>
          <Badge className="code max-w-full" title={project.workspaceSubpath} translate="no">
            <WorkspaceFolder size={ICON.xs} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{project.workspaceSubpath}</span>
          </Badge>
        </div>
      ) : null}

      <div className="workspace-dossier-stamp workspace-dossier-stamps">
        <Badge render={<time dateTime={project.createdAt} />} title={project.createdAt}>
          <ActionCalendar size={ICON.xs} aria-hidden="true" />
          {t("admin.v2.agent_meta_created", { time: formatRelativeTime(project.createdAt, t) })}
        </Badge>
        <Badge render={<time dateTime={project.updatedAt} />} title={project.updatedAt}>
          <ActionRetry size={ICON.xs} aria-hidden="true" />
          {t("admin.v2.agent_meta_updated", { time: formatRelativeTime(project.updatedAt, t) })}
        </Badge>
      </div>
    </section>
  );
}

/** The project's brief. It is edited on the Settings tab with the name, so
 *  the pencil opens that tab rather than editing in place. */
function ProjectDescription({
  project,
  onOpenSettings,
}: {
  project: ProjectRecord;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  const description = project.description?.trim();
  return (
    <section className="project-general-section" aria-labelledby="project-general-description">
      <div className="project-general-section-head">
        <h2 id="project-general-description" className="workspace-dossier-section-title">
          {t("project.description")}
        </h2>
        {onOpenSettings ? (
          <Button
            type="button"
            variant="ghost"
            className="workspace-dossier-icon-btn"
            tooltip={t("project.description_edit")}
            onClick={onOpenSettings}
          >
            <ActionEdit size={ICON.sm} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {description ? (
        <p className="project-description">{description}</p>
      ) : (
        <p className="project-description is-empty">{t("project.description_empty")}</p>
      )}
    </section>
  );
}

/** Who works in the project, as a roll call: the lead first, then the rest,
 *  capped so General stays a glance. The cards live on the Members tab. */
function ProjectCrewSummary({
  project,
  agents,
  onOpenMembers,
}: {
  project: ProjectRecord;
  agents: EmployeeAgent[];
  onOpenMembers: () => void;
}) {
  const { t } = useTranslation();
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const members = useMemo(() => orderedProjectMembers(project), [project]);
  const shown = members.slice(0, CREW_SUMMARY_LIMIT);
  const hidden = members.length - shown.length;

  return (
    <section className="project-general-section" aria-labelledby="project-general-members">
      <div className="project-general-section-head">
        <h2 id="project-general-members" className="workspace-dossier-section-title">
          {t("project.members")}
          <span className="tnum">{members.length}</span>
        </h2>
        <Button type="button" variant="ghost" size="dense" onClick={onOpenMembers}>
          {t(members.length ? "project.members_manage" : "project.member_add")}
          <span aria-hidden="true">→</span>
        </Button>
      </div>
      {shown.length ? (
        <ul className="project-crew-summary">
          {shown.map((member) => {
            const agent = agentsById.get(member.agentId);
            const { available, enabled, availability } = projectMemberState(member, agent);
            const name = agent?.displayName || t("project.member_unavailable");
            return (
              <li key={member.agentId} className={`project-crew-row${available ? "" : " is-missing"}`}>
                <AgentStateBadge
                  agent={agent?.executorKind}
                  ready={enabled && availability === "ready"}
                  availability={availability}
                  imageUrl={agent?.profileImageUrl}
                  name={name}
                />
                <span className="project-crew-row-name">
                  <strong>{name}</strong>
                  {member.agentId === project.leadAgentId ? <LeadBadge /> : null}
                </span>
                <span className="project-crew-row-meta">
                  {t(`project.roles.${member.role}`)}
                  {agent ? ` · ${agentLabel(agent.executorKind)}` : ""}
                </span>
                {!member.enabled ? <TonePill tone="neutral" label={t("project.member_disabled")} /> : null}
                {!available ? <TonePill tone="warn" label={t("project.member_missing")} /> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="project-description is-empty">{t("project.profile_empty_hint")}</p>
      )}
      {hidden > 0 ? (
        <p className="project-crew-summary-more">{t("project.members_more", { count: hidden })}</p>
      ) : null}
    </section>
  );
}

/** The General tab: what the project is for and who works in it, beside its
 *  identity rail. Read-only — edits happen on Members and Settings. */
export function ProjectGeneral({
  project,
  agents,
  computer,
  onOpenSettings,
  onOpenMembers,
}: {
  project: ProjectRecord;
  agents: EmployeeAgent[];
  computer: RailComputer;
  onOpenSettings?: () => void;
  onOpenMembers: () => void;
}) {
  return (
    <div className="workspace-profile project-profile">
      {/* Same dossier grammar as the team record: what the project is for and
          who works in it are the document, its identity is the rail. */}
      <div className="workspace-profile-dossier">
        <div className="workspace-dossier-doc project-general-doc">
          <ProjectDescription project={project} onOpenSettings={onOpenSettings} />
          <ProjectCrewSummary project={project} agents={agents} onOpenMembers={onOpenMembers} />
        </div>
        <ProjectIdentityRail project={project} computer={computer} onOpenSettings={onOpenSettings} />
      </div>
    </div>
  );
}
