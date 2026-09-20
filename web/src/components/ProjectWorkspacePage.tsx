"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useUrlSearchState } from "../hooks/useUrlSearchState";
import { computerId as stableComputerId } from "../lib/createAgent";
import { agentLabel } from "../lib/plan";
import {
  orderedProjectMembers,
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
  ActionEdit,
  ICON,
  NavBack,
  NavProjects,
} from "./icons";
import { PageHeader } from "./PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProjectMemberEditor } from "./ProjectMemberEditor";
import { ProjectWorkspaceFiles } from "./ProjectWorkspaceFiles";
import {
  WorkspaceEmpty,
} from "./workspace/WorkspacePrimitives";
import { RecordBand, type RecordFact } from "./workspace/RecordBand";
import { TonePill } from "./StatusPill";
import { Button } from "@/components/ui/button";

import { ProjectTasks } from "./ProjectTasks";
import { TaskDrawer } from "./task-board/TaskDrawer";
import { TaskRecordView } from "./task-record/TaskRecordView";
import { useBacklogTaskForm } from "../hooks/useBacklogTaskForm";
import { useRecordDrawerMirror } from "../hooks/useRecordDrawerMirror";
import { taskRef } from "../lib/taskRef";


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
    "tasks" as ProjectPageTab,
    parseProjectPageTab,
    (value) => value === "tasks" ? null : value,
    "push",
  );
  /* The open record, as a param this path owns — a project task opens over
     the project rather than sending the reader to the backlog board, and the
     record is still an address somebody can paste. */
  const [recordTaskId, setRecordTaskId] = useUrlSearchState<string | null>(
    "task",
    null,
    (value) => value || null,
    (value) => value,
    "push",
  );
  /* The exiting drawer still needs its record after the param clears. */
  const recordMirror = useRecordDrawerMirror(recordTaskId, recordTaskId);
  const drawerRecordId = recordMirror.record;
  /* The same form the backlog board edits through, seeded so a task created
     here belongs to this project. */
  const taskForm = useBacklogTaskForm({ currentUser, seed: { projectId: project.id } });
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
            locale={i18n.language}
            onOpenRecord={(taskId) => setRecordTaskId(taskId)}
          />
        </TabsContent>
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
      </div>

      <ProjectMemberEditor
        open={memberEditor !== null}
        member={memberEditor?.member ?? null}
        project={project}
        agents={agents}
        computers={computers}
        onClose={() => setMemberEditor(null)}
      />

      {/* One record surface, the same one both boards mount — the project
          keeps the reader's place, and editing goes through the shared form
          drawer stacked above it. */}
      {drawerRecordId ? (
        <TaskRecordView
          taskId={drawerRecordId}
          tasks={tasks}
          drawer={{
            open: Boolean(recordTaskId),
            onClose: () => setRecordTaskId(null),
            onClosed: recordMirror.release,
          }}
          /* The drawer rides over the project, so the project is where it
             came from — not the backlog board it never went through. */
          originLabel={project.name}
          tabSearchKey="recordTab"
          onEdit={taskForm.editTask}
          onOpenThread={onOpenThread}
          onOpenRecord={(nextId) => setRecordTaskId(nextId)}
          onDeleted={() => setRecordTaskId(null)}
        />
      ) : null}

      {taskForm.form ? (
        <TaskDrawer
          open={taskForm.open}
          form={taskForm.form}
          logicalAgents={agents}
          projects={[project]}
          teams={teams}
          saving={taskForm.saving}
          deleting={taskForm.deleting}
          initialFocus={taskForm.assignmentFocus ? "assignment" : "title"}
          title={taskForm.form.id ? t("backlog.edit_task") : t("backlog.new_task")}
          subtitle={taskForm.form.id ? `${t("backlog.col_ref")} ${taskRef(taskForm.form.id)}` : t("backlog.new_task_id")}
          onClose={() => { void taskForm.requestClose(); }}
          onClosed={taskForm.release}
          onChange={(next) => {
            if (next.variant === "backlog") taskForm.setForm(next);
          }}
          onSubmit={(event) => void taskForm.submit(event)}
          onDelete={taskForm.form.id ? () => { void taskForm.remove(); } : undefined}
          layer={drawerRecordId ? 1 : 0}
        />
      ) : null}
    </Tabs>
  );
}
