"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { computerId as stableComputerId } from "../lib/createAgent";
import { agentLabel } from "../lib/plan";
import {
  orderedProjectMembers,
  DEFAULT_PROJECT_PAGE_TAB,
  parseProjectPageTab,
  projectMemberState,
  projectPageActions,
  projectReadOnly,
  MAX_PROJECT_MEMBERS,
  PROJECT_PAGE_TABS,
  type ProjectPageTab,
} from "../lib/projectPage";
import { truncateId, formatRelativeTime } from "../lib/adminHelpers";
import type {
  AgentTeam,
  CurrentUser,
  DaemonNodeMonitorRecord,
  EmployeeAgent,
  ProjectMember,
  ProjectRecord,
  RelayTaskListItem,
} from "../types";
import { AgentStateBadge } from "./AgentStateBadge";
import {
  ActionAdd,
  ActionCalendar,
  ActionEdit,
  ActionRetry,
  ICON,
  NavBack,
  NavProjects,
  WorkspaceFolder,
  nodeOwnershipIcon,
} from "./icons";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "./PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProjectMemberEditor } from "./ProjectMemberEditor";
import { ProjectWorkspaceFiles } from "./ProjectWorkspaceFiles";
import {
  WorkspaceEmpty,
} from "./workspace/WorkspacePrimitives";
import { RecordBand, type RecordFact } from "./workspace/RecordBand";
import { LeadBadge } from "./LeadBadge";
import { TonePill } from "./StatusPill";
import { Button } from "@/components/ui/button";

import { ProjectTasks } from "./ProjectTasks";
import { navigateToAppPath } from "../lib/appRoute";
import { projectTasksHref } from "./ProjectTaskNav";


/* The header's subtitle says what the open tab is for. It used to describe
   the tasks board on every tab, including the three that are not it. */
const PROJECT_TAB_SUBTITLE: Record<ProjectPageTab, string> = {
  tasks: "project.tasks_subtitle",
  profile: "project.tasks_team_subtitle",
  workspace: "project.tasks_workspace_subtitle",
};

function ProjectMark({ size = 18 }: { size?: number }) {
  return (
    <span className="project-mark" aria-hidden="true">
      <NavProjects size={size} />
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

type RailComputer = { label: string; Icon: ReturnType<typeof nodeOwnershipIcon> };

/** The project's identity, beside its crew — the same rail the team record
 *  carries: mark, name, the computer and folder it lives in, and its stamps.
 *  The name is renamed through Project settings, which owns every edit. */
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
  const { Icon: ComputerIcon } = computer;
  return (
    <aside className="workspace-dossier-rail" aria-label={t("workspace.identity_label")}>
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
          <ComputerIcon size={ICON.xs} className="shrink-0" aria-hidden="true" />
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
    </aside>
  );
}

function ProjectProfile({
  project,
  agents,
  computer,
  onOpenSettings,
  onAddMember,
  onEditMember,
}: {
  project: ProjectRecord;
  agents: EmployeeAgent[];
  computer: RailComputer;
  onOpenSettings?: () => void;
  onAddMember?: () => void;
  onEditMember?: (member: ProjectMember) => void;
}) {
  const { t } = useTranslation();
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const members = useMemo(() => orderedProjectMembers(project), [project]);

  return (
    <div className="workspace-profile project-profile">
      {/* Same dossier grammar as the team record: the crew is the document,
          the project's identity is the rail beside it. */}
      <div className="workspace-profile-dossier">
        <section className="workspace-dossier-doc" aria-labelledby="project-profile-members">
          <h2 id="project-profile-members" className="workspace-dossier-section-title">
            {t("project.members")}
            <span className="tnum">{members.length}</span>
          </h2>
          <ProjectCrew
            project={project}
            members={members}
            agentsById={agentsById}
            onAddMember={onAddMember}
            onEditMember={onEditMember}
          />
        </section>
        <ProjectIdentityRail project={project} computer={computer} onOpenSettings={onOpenSettings} />
      </div>
    </div>
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
    </>
  );
}

export function ProjectWorkspacePage({
  project,
  agents,
  teams,
  tasks,
  currentUser,
  computers,
  onOpenThread,
  onOpenSettings,
  onBack,
}: {
  project: ProjectRecord;
  agents: EmployeeAgent[];
  teams: AgentTeam[];
  /* The shell already polls the task list; a second observer on the same
     query key with its own interval polled the whole table twice over for
     one project's lanes. */
  tasks: RelayTaskListItem[];
  currentUser: CurrentUser;
  computers: DaemonNodeMonitorRecord[];
  onOpenThread: (sessionId: string) => void;
  onNewThread?: () => void;
  onOpenSettings: () => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [memberEditor, setMemberEditor] = useState<{ member: ProjectMember | null } | null>(null);
  const [pageTab, setPageTab] = useUrlSearchState(
    "tab",
    DEFAULT_PROJECT_PAGE_TAB,
    parseProjectPageTab,
    (value) => value === DEFAULT_PROJECT_PAGE_TAB ? null : value,
    "push",
  );
  // Accept legacy project task links and redirect them to the Tasks destination.
  const [recordTaskId] = useUrlSearchState<string | null>(
    "task",
    null,
    (value) => value || null,
    (value) => value,
    "push",
  );
  // Preserve old project-task deep links, but task details now belong to Tasks.
  useEffect(() => {
    if (!recordTaskId) return;
    const recordTab = new URLSearchParams(window.location.search).get("recordTab");
    const suffix = recordTab === "files" || recordTab === "definition" ? `&tab=${recordTab}` : "";
    void navigateToAppPath(projectTasksHref(project.id, recordTaskId) + suffix, { replace: true });
  }, [project.id, recordTaskId]);
  const computer = computers.find((node) => stableComputerId(node) === project.computerId);
  const computerLabel = computer?.displayName?.trim()
    || project.computerId.replace(/^device:[^:]+:/, "");
  const railComputer: RailComputer = {
    label: computerLabel,
    Icon: nodeOwnershipIcon(!computer ? "pending" : computer.managedNodeId?.trim() ? "managed" : "local"),
  };
  const state = project.archivedAt ? "archived" : project.enabled ? "active" : "disabled";
  /* Same split as the team record: the title line carries the state and the
     id; the computer, folder and stamps live in the Agents tab's rail. */
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
      key: "id",
      label: t("project.band_id"),
      value: <Badge className="code" translate="no">{truncateId(project.id)}</Badge>,
      title: project.id,
    },
  ];

  const actions = projectPageActions(project);
  /* Archived/disabled projects are read-only rooms — no member management. */
  const membersReadOnly = projectReadOnly(project);

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
        /* The record's common facts ride the title line on every tab instead
           of claiming a band row above the tab body, so each panel keeps the
           full height under the header. */
        facts={<RecordBand facts={bandFacts} label={t("project.band_label")} variant="title" />}
        title={(
          <span className="workspace-header-title">
            <span className="workspace-header-mark"><ProjectMark size={ICON.sm} /></span>
            {project.name}
          </span>
        )}
        subtitle={t(PROJECT_TAB_SUBTITLE[pageTab])}
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
                {tab === "tasks"
                  ? t("project.tasks_tab")
                  : tab === "profile"
                  ? t("project.tasks_team_tab")
                  : t("workspace.tab_workspace")}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
      />

      <div className="workspace-body">
        <TabsContent value="tasks" className="project-tasks-panel">
          <ProjectTasks
            key={project.id}
            project={project}
            tasks={tasks}
            agents={agents}
            teams={teams}
            onOpenRecord={(taskId) => void navigateToAppPath(projectTasksHref(project.id, taskId))}
          />
        </TabsContent>
        <TabsContent value="profile">
          <ProjectProfile
            project={project}
            agents={agents}
            computer={railComputer}
            onOpenSettings={actions.settings ? onOpenSettings : undefined}
            onAddMember={membersReadOnly ? undefined : () => setMemberEditor({ member: null })}
            onEditMember={membersReadOnly ? undefined : (member) => setMemberEditor({ member })}
          />
        </TabsContent>
        <TabsContent value="workspace" className="workspace-inspect">
          <ProjectWorkspaceFiles projectId={project.id} />
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
