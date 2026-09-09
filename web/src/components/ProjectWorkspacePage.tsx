"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getWorkspaceBrief } from "../api";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { computerId as stableComputerId } from "../lib/createAgent";
import { agentLabel } from "../lib/plan";
import {
  orderedProjectMembers,
  parseProjectPageTab,
  projectActivitiesState,
  projectMemberState,
  projectPageActions,
  scopeProjectActivities,
  MAX_PROJECT_MEMBERS,
  PROJECT_PAGE_TABS,
  type ProjectPageTab,
} from "../lib/projectPage";
import { truncateId, formatRelativeTime } from "../lib/adminHelpers";
import type { DaemonNodeMonitorRecord, EmployeeAgent, ProjectMember, ProjectRecord } from "../types";
import { AgentStateBadge } from "./AgentStateBadge";
import {
  ActionAdd,
  ActionEdit,
  ICON,
  NavBack,
  WorkspaceFolder,
} from "./icons";
import { PageHeader } from "./PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProjectMemberEditor } from "./ProjectMemberEditor";
import { ProjectWorkspaceFiles } from "./ProjectWorkspaceFiles";
import {
  ActivitiesSkeleton,
  WorkspaceActivities,
  WorkspaceEmpty,
  WorkspaceError,
} from "./workspace/WorkspacePrimitives";
import { RecordBand, type RecordFact } from "./workspace/RecordBand";
import { TonePill } from "./StatusPill";
import { Button } from "@/components/ui/button";

const PROJECT_ACTIVITY_POLL_MS = 3000;

function ProjectMark({ size = 18 }: { size?: number }) {
  return (
    <span className="project-mark" aria-hidden="true">
      <WorkspaceFolder size={size} />
    </span>
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
  const functionTitle = member.functionTitle.trim();
  /* The title only earns its own words when it says something the name does
     not — otherwise the lane would print the same fact twice. */
  const showFunctionTitle = functionTitle.length > 0 && functionTitle !== name.trim();

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
            {lead ? <TonePill tone="info" label={t("project.lead_badge")} /> : null}
            {!member.enabled ? <TonePill tone="neutral" label={t("project.member_disabled")} /> : null}
            {!available ? <TonePill tone="warn" label={t("project.member_missing")} /> : null}
          </span>
          <span className="project-member-tile-meta">
            {agent ? agentLabel(agent.executorKind) : member.agentId}
            {" · "}
            {t(`project.roles.${member.role}`)}
          </span>
        </span>
      </header>

      <div className="project-member-tile-body">
        <p className="project-member-tile-responsibilities">
          {showFunctionTitle ? (
            <>
              <strong>{functionTitle}</strong>
              {" — "}
            </>
          ) : null}
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

function ProjectProfile({
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

  return (
    <div className="workspace-profile project-profile">
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
          {onAddMember && members.length < MAX_PROJECT_MEMBERS ? (
            <Button variant="ghost" type="button" className="project-member-tile-add" onClick={onAddMember}>
              <ActionAdd size={ICON.md} aria-hidden="true" />
              <span>{t("project.member_add")}</span>
            </Button>
          ) : null}
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
    </div>
  );
}

export function ProjectWorkspacePage({
  project,
  agents,
  computers,
  onOpenThread,
  onNewThread,
  onOpenSettings,
  onBack,
}: {
  project: ProjectRecord;
  agents: EmployeeAgent[];
  computers: DaemonNodeMonitorRecord[];
  onOpenThread: (sessionId: string) => void;
  onNewThread: () => void;
  onOpenSettings: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [memberEditor, setMemberEditor] = useState<{ member: ProjectMember | null } | null>(null);
  const [pageTab, setPageTab] = useUrlSearchState(
    "tab",
    "profile" as ProjectPageTab,
    parseProjectPageTab,
    (value) => value === "profile" ? null : value,
    "push",
  );
  const briefQuery = useQuery({
    queryKey: ["project-workspace-brief", project.id],
    queryFn: ({ signal }) => getWorkspaceBrief({ projectId: project.id }, signal),
    enabled: pageTab === "activities",
    refetchInterval: pageTab === "activities" ? PROJECT_ACTIVITY_POLL_MS : false,
  });
  const computer = computers.find((node) => stableComputerId(node) === project.computerId);
  const computerLabel = computer?.displayName?.trim()
    || project.computerId.replace(/^device:[^:]+:/, "");
  const state = project.archivedAt ? "archived" : project.enabled ? "active" : "disabled";
  const bandFacts: RecordFact[] = [
    {
      key: "state",
      label: t("project.band_state"),
      value: (
        <TonePill
          tone={state === "active" ? "good" : state === "disabled" ? "warn" : "neutral"}
          label={t(`project.state_${state}`)}
        />
      ),
    },
    {
      key: "computer",
      label: t("project.computer"),
      value: computerLabel,
      title: project.computerId,
    },
    {
      key: "updated",
      label: t("workspace.band_updated"),
      value: formatRelativeTime(project.updatedAt, t),
    },
    {
      key: "id",
      label: t("project.band_id"),
      value: truncateId(project.id),
      technical: true,
      title: project.id,
    },
  ];

  const error = briefQuery.error instanceof Error
    ? briefQuery.error.message
    : briefQuery.error
      ? String(briefQuery.error)
      : "";
  const scopedBrief = briefQuery.data
    ? scopeProjectActivities(briefQuery.data, project.id)
    : undefined;
  const actions = projectPageActions(project);
  const activitiesState = projectActivitiesState({
    isLoading: briefQuery.isLoading,
    hasData: Boolean(scopedBrief),
    hasError: Boolean(error),
  });
  /* Archived/disabled projects are read-only rooms — no member management. */
  const membersReadOnly = Boolean(project.archivedAt || !project.enabled);

  return (
    <Tabs
      render={<section id="project-detail-panel" tabIndex={-1} />}
      className="workspace-page project-workspace-page"
      aria-label={t("project.page_label", { project: project.name })}
      value={pageTab}
      onValueChange={(value) => setPageTab(value as ProjectPageTab)}
    >
      <PageHeader
        kicker={t("project.page_kicker")}
        title={(
          <span className="workspace-header-title">
            <span className="workspace-header-mark"><ProjectMark size={ICON.sm} /></span>
            {project.name}
          </span>
        )}
        subtitle={t("project.page_subtitle", { count: project.members.length })}
        titleVariant="record"
        layout="stacked"
        actions={(
          <>
            <Button type="button" variant="ghost" size="dense" className="project-mobile-back" onClick={onBack}>
              <NavBack size={ICON.sm} aria-hidden="true" />
              {t("project.back")}
            </Button>
            {actions.settings ? (
              <Button type="button" variant="outline" size="dense" onClick={onOpenSettings}>
                <ActionEdit size={ICON.sm} aria-hidden="true" />
                {t("project.edit")}
              </Button>
            ) : null}
            {actions.newThread ? (
              <Button
                type="button"
                variant="ghost"
                // The shared list-header create affordance — a plain ghost
                // plus, same as every other list header.
                className="page-header-icon-action"
                onClick={onNewThread}
                aria-label={t("project.new_thread", { project: project.name })}
                tooltip={t("project.new_thread_short")}
              >
                <ActionAdd size={ICON.md} aria-hidden="true" />
              </Button>
            ) : null}
          </>
        )}
        toolbar={(
          <TabsList className="workspace-page-tabs" aria-label={t("project.sections")}>
            {PROJECT_PAGE_TABS.map((tab) => (
              <TabsTrigger
                key={tab}
                value={tab}
                className={`workspace-page-tab${pageTab === tab ? " is-active" : ""}`}
              >
                {tab === "profile"
                  ? t("workspace.tab_profile")
                  : tab === "workspace"
                    ? t("workspace.tab_workspace")
                    : t("workspace.tab_activities")}
                {tab === "activities" && scopedBrief?.sessions.length ? (
                  <span className="workspace-page-tab-count tnum">{scopedBrief.sessions.length}</span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
      />
      <RecordBand facts={bandFacts} label={t("project.band_label")} />

      <div className="workspace-body">
        <TabsContent value="profile">
          <ProjectProfile
            project={project}
            agents={agents}
            onAddMember={membersReadOnly ? undefined : () => setMemberEditor({ member: null })}
            onEditMember={membersReadOnly ? undefined : (member) => setMemberEditor({ member })}
          />
        </TabsContent>
        <TabsContent value="workspace" className="workspace-inspect">
          <ProjectWorkspaceFiles projectId={project.id} />
        </TabsContent>
        <TabsContent value="activities">
          {activitiesState === "loading" ? (
            <ActivitiesSkeleton />
          ) : activitiesState === "error" || !scopedBrief ? (
            <WorkspaceError
              message={error || t("workspace.load_failed")}
              onRetry={() => void briefQuery.refetch()}
            />
          ) : (
            <WorkspaceActivities
              brief={scopedBrief}
              emptyMark={<ProjectMark />}
              onOpenThread={onOpenThread}
            />
          )}
        </TabsContent>
      </div>

      <ProjectMemberEditor
        open={memberEditor !== null}
        member={memberEditor?.member ?? null}
        project={project}
        agents={agents}
        computers={computers}
        onClose={() => setMemberEditor(null)}
      />
    </Tabs>
  );
}
