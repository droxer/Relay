"use client";

import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { navigateToAppPath } from "../lib/appRoute";
import { PROJECT_LEAD_TOPICS, projectLeadTopicLabel, type ProjectLeadTopic } from "../lib/projectLeadTopics";
import { projectMemberState } from "../lib/projectPage";
import type { ProjectRecord, UserAgent } from "../types";
import { AgentStateBadge } from "./AgentStateBadge";
import { ChevronDownIcon, ICON, NavThreads } from "./icons";
import { TonePill } from "./StatusPill";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Who manages the Project, as one quiet line above its numbers.
 *  The holder is an ordinary roster member that brings the manager tools to
 *  its own tasks and automations. Discuss opens the Project's one lead Thread
 *  — directly, or with an everyday question waiting in the composer — and
 *  the Agents tab stays the one place the role changes hands. Everything shown
 *  comes from the project and agents the page already has. */
export function ProjectManagerLine({ project, agents, onManage, onDiscuss, discussing = false }: {
  project: ProjectRecord;
  agents: UserAgent[];
  /** Opens where the role is assigned; absent when the viewer cannot edit. */
  onManage?: () => void;
  /** Opens the lead Thread, with a topic's question drafted when one is
   *  picked; absent when the viewer cannot talk to the lead here. */
  onDiscuss?: (topic?: ProjectLeadTopic) => void;
  discussing?: boolean;
}) {
  const { t } = useTranslation();
  const member = project.members.find((candidate) => candidate.agentId === project.leadAgentId);
  const label = t("project.roles.project_manager");

  if (!member) {
    return (
      <div className="project-manager-line is-open" role="group" aria-label={label}>
        <span className="project-manager-line-text">
          <span className="project-manager-line-role">{label}</span>
          <span className="project-manager-line-empty">{t("project_manager.unassigned_role")}</span>
        </span>
        {onManage ? (
          <Button type="button" variant="outline" size="dense" onClick={onManage}>
            {t("project_manager.assign_role")}
          </Button>
        ) : null}
      </div>
    );
  }

  const agent = agents.find((candidate) => candidate.id === member.agentId);
  const { available, enabled, availability } = projectMemberState(member, agent);
  const name = agent?.displayName || t("project.member_unavailable");
  const href = `/agents/${encodeURIComponent(member.agentId)}`;
  const openAgent = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    void navigateToAppPath(href);
  };

  return (
    <div className="project-manager-line" role="group" aria-label={label}>
      <AgentStateBadge
        agent={agent?.executorKind}
        ready={enabled && availability === "ready"}
        /* A disabled holder cannot work whatever its runtime reports, so the
           pip must not read ready beside the Disabled pill. */
        availability={enabled ? availability : undefined}
        imageUrl={agent?.profileImageUrl}
        name={name}
      />
      <span className="project-manager-line-text">
        <a className="project-manager-line-name" href={href} onClick={openAgent}>{name}</a>
        <span className="project-manager-line-role">
          {label}
          <span aria-hidden="true"> · </span>
          {t(`project.roles.${member.role}`)}
        </span>
      </span>
      {!enabled ? <TonePill tone="neutral" label={t("project.member_disabled")} /> : null}
      {enabled && !available ? <TonePill tone="warn" label={t("project.member_missing")} /> : null}
      {/* A disabled holder cannot answer, so there is no one to discuss with. */}
      {(onDiscuss && enabled) || onManage ? (
        <span className="project-manager-line-actions">
          {onDiscuss && enabled ? <LeadDiscussActions onDiscuss={onDiscuss} discussing={discussing} /> : null}
          {onManage ? (
            <Button type="button" variant="ghost" size="dense" onClick={onManage}>
              {t("project_manager.change")}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** Discuss, and beside it the everyday questions that start one. */
function LeadDiscussActions({ onDiscuss, discussing }: {
  onDiscuss: (topic?: ProjectLeadTopic) => void;
  discussing: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span className="project-manager-line-discuss" role="group" aria-label={t("project_manager.discuss")}>
      <Button type="button" variant="outline" size="dense" disabled={discussing} aria-busy={discussing || undefined} onClick={() => onDiscuss()}>
        <NavThreads size={ICON.sm} aria-hidden="true" />
        {t("project_manager.discuss")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={discussing}
          render={(
            <Button type="button" variant="outline" size="icon-dense" aria-label={t("project_manager.quick_topics")}>
              <ChevronDownIcon size={ICON.sm} aria-hidden="true" />
            </Button>
          )}
        />
        <DropdownMenuContent align="end">
          {PROJECT_LEAD_TOPICS.map((topic) => (
            <DropdownMenuItem key={topic} onClick={() => onDiscuss(topic)}>
              {projectLeadTopicLabel(t, topic)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
