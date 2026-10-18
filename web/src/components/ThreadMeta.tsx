"use client";

import { useTranslation } from "react-i18next";
import { nodeOwnershipProfile } from "../lib/adminHelpers";
import { pathForAppState } from "../lib/appRoute";
import { computerId as stableComputerId } from "../lib/createAgent";
import { useProjectLookup } from "../hooks/useProjectLookup";
import type { DaemonNodeMonitorRecord, UserAgent, RelaySession, TaskStatus } from "../types";
import { AvatarStack } from "./AvatarStack";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";
import { TaskStatusIcon } from "./TaskStatusIcon";
import { ICON, NavProjects, NodeOwnershipIcon } from "./icons";

/** The task a thread is doing, as the header names it. */
export type ThreadTaskFact = {
  /** `#12` / `AUTO-3`. */
  ref: string;
  status: TaskStatus;
  href: string;
  onOpen: () => void;
};

/**
 * A thread's coordinates, as marks rather than a table of words.
 *
 * Which task the work is for and where that task stands, who is in the room,
 * which machine answers for them, which project the work belongs to — the
 * facts a reader checks mid conversation. They were an eyebrow-and-value band under the header, which
 * cost a whole row of transcript and set uppercase labels against a
 * title; the room was ALSO drawn a second time beside them as a face stack.
 *
 * NOTHING HERE IS DRAWN TWICE. The room is this stack or the single agent
 * chip, never both; the computer and the project are stated here and no
 * longer restated on the composer's targets rail while the thread is running
 * (that rail keeps them only where the header cannot: a thread still being
 * staged, and phone widths where the header steps aside for the top bar).
 */
export function ThreadMeta({
  session,
  task,
  agentName,
  participants,
  computers,
  onOpenProject,
}: {
  session: RelaySession;
  /** The task this thread works on, when it has one. */
  task?: ThreadTaskFact;
  /** The agent that last answered here, for a room the roster cannot name. */
  agentName?: string;
  /** The room, in join order. */
  participants: UserAgent[];
  computers: DaemonNodeMonitorRecord[];
  onOpenProject: (projectId: string) => void;
}) {
  const { t } = useTranslation();
  const projectOf = useProjectLookup();
  const project = session.projectId
    ? { id: session.projectId, name: projectOf(session.projectId)?.name || session.projectId }
    : null;
  const computer = computers.find((node) => stableComputerId(node) === session.computerId);

  return (
    <div className="thread-meta" aria-label={t("thread.band_label")}>
      {task ? <TaskChip task={task} /> : null}
      {project ? (
        <ProjectChip project={project} onOpen={onOpenProject} />
      ) : null}
      <RoomMark participants={participants} agentName={agentName} />
      {session.computerId ? (
        <ComputerChip computerId={session.computerId} node={computer} />
      ) : null}
    </div>
  );
}

/**
 * The thread's task and where it stands — the status the transcript's
 * lifecycle markers lead up to, readable without scrolling to the last one.
 * It is a link: the task is where a person accepts, retries, or moves it.
 */
function TaskChip({ task }: { task: ThreadTaskFact }) {
  const { t } = useTranslation();
  const status = t(`backlog.statuses.${task.status}`);
  const label = t("thread.band_task_status", { ref: task.ref, status });
  return (
    <a
      className="thread-meta-chip thread-meta-task"
      href={task.href}
      title={label}
      data-status={task.status}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        task.onOpen();
      }}
    >
      <TaskStatusIcon status={task.status} />
      <span className="sr-only">{t("thread.band_task")}: </span>
      <span className="thread-meta-ref" translate="no">{task.ref}</span>
      <span className="thread-meta-status">{status}</span>
    </a>
  );
}

/** The project this thread contributes to — the one coordinate that leads
 *  somewhere, so it is the one chip that is a link. */
function ProjectChip({ project, onOpen }: {
  project: { id: string; name: string };
  onOpen: (projectId: string) => void;
}) {
  const { t } = useTranslation();
  const href = pathForAppState({
    route: "projects",
    mobileView: "chat",
    sessionId: null,
    projectId: project.id,
  });
  return (
    <a
      className="thread-meta-chip thread-meta-project"
      href={href}
      title={`${t("thread.band_project")}: ${project.name}`}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onOpen(project.id);
      }}
    >
      <NavProjects size={ICON.sm} aria-hidden="true" />
      <span className="sr-only">{t("thread.band_project")}: </span>
      <span className="thread-meta-name">{project.name}</span>
    </a>
  );
}

/**
 * Who answers here.
 *
 * One agent is a face AND its name — a lone anonymous face makes the reader
 * hover to learn the only thing they wanted. Several are a face stack, where
 * the names would cost more width than the row has and belong in tooltips.
 */
function RoomMark({ participants, agentName }: {
  participants: UserAgent[];
  agentName?: string;
}) {
  const { t } = useTranslation();
  if (participants.length > 1) {
    return (
      <AvatarStack
        className="thread-meta-room"
        label={t("thread.participants")}
        items={participants.map((participant) => ({
          id: participant.id,
          name: participant.displayName,
          mark: (
            <ProfileImage
              src={participant.profileImageUrl}
              alt=""
              fallback={<IdentityMark kind="agent" />}
            />
          ),
        }))}
      />
    );
  }
  const solo = participants[0];
  // A thread whose roster is empty still has an agent answering in it — the
  // one resolved from its last run. It has no record to draw a face from, so
  // it wears the default agent mark.
  const name = solo?.displayName ?? agentName;
  if (!name) return null;
  return (
    <span className="thread-meta-chip" title={`${t("thread.band_agent")}: ${name}`}>
      <span className="thread-meta-face">
        <ProfileImage src={solo?.profileImageUrl} alt="" fallback={<IdentityMark kind="agent" />} />
      </span>
      <span className="sr-only">{t("thread.band_agent")}: </span>
      <span className="thread-meta-name">{name}</span>
    </span>
  );
}

/**
 * The machine the thread is pinned to, with its liveness.
 *
 * Same vocabulary as every other computer readout in the app: the ownership
 * glyph (cloud / laptop) says whose machine it is, the presence dot says
 * whether it is there right now. A computer the fleet no longer lists keeps
 * its id and reads offline — the fact outlives the record.
 */
function ComputerChip({ computerId, node }: {
  computerId: string;
  node?: DaemonNodeMonitorRecord;
}) {
  const { t } = useTranslation();
  const ownership = node ? nodeOwnershipProfile(node) : null;
  const online = Boolean(node?.online) && !node?.stale;
  const name = (node && "displayName" in node && typeof node.displayName === "string" && node.displayName.trim())
    || computerId.replace(/^device:[^:]+:/, "");
  const presenceLabel = online ? t("nodes.presence_online") : t("nodes.presence_offline");
  return (
    <span
      className="thread-meta-chip thread-meta-computer"
      data-ownership={ownership ?? undefined}
      title={`${t("thread.band_computer")}: ${name} · ${presenceLabel}`}
    >
      <span className="adm-presence" data-online={online ? "true" : "false"} aria-hidden="true" />
      <NodeOwnershipIcon ownership={ownership ?? "pending"} size={ICON.sm} aria-hidden="true" />
      <span className="sr-only">{t("thread.band_computer")}: </span>
      <span className="thread-meta-name" translate="no">{name}</span>
      <span className="sr-only"> · {presenceLabel}</span>
    </span>
  );
}
