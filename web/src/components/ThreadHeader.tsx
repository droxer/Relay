import { useTranslation } from "react-i18next";
import type { EmployeeAgent, RelaySession } from "../types";
import {
  ICON,
  NavBack,
  NavThreads,
} from "./icons";
import { ArtifactNavButton } from "./ArtifactNavButton";
import { AvatarStack } from "./AvatarStack";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";
import { Button, buttonVariants } from "@/components/ui/button";
import { canonicalBrowserUrl, navigateToAppPath, pathForAppState } from "../lib/appRoute";

export function ThreadHeader({ taskId, activeSession, projectId, participants, artifactCount, spaceOpen, threadListHidden, onToggleSpace, onToggleThreadList, onBackToThreads }: {
  taskId?: string | null;
  activeSession: RelaySession | undefined;
  projectId?: string | null;
  /** Agents in the room, in join order. Shown only once a thread has more
   *  than one — a solo thread already names its agent in the composer. Drawn
   *  as a face stack: the header is a row the title has first claim on, so
   *  the roster costs a fixed width and keeps its names in tooltips. */
  participants?: EmployeeAgent[];
  artifactCount: number;
  spaceOpen: boolean;
  threadListHidden: boolean;
  onToggleSpace: () => void;
  onToggleThreadList: () => void;
  onBackToThreads: () => void;
}) {
  const { t } = useTranslation();
  const parentProjectId = projectId ?? activeSession?.projectId;
  const projectActivitiesHref = taskId
    ? canonicalBrowserUrl(`/backlog/${encodeURIComponent(taskId)}`, typeof window !== "undefined" ? window.location.search : "")
    : parentProjectId
    ? `${pathForAppState({ route: "projects", mobileView: "chat", sessionId: null, projectId: parentProjectId })}?tab=activities`
    : null;
  return (
    <header className="chat-header">
      <div className="chat-title">
        {projectActivitiesHref ? (
          <a
            className={buttonVariants({ variant: "ghost" })}
            href={projectActivitiesHref}
            aria-label={t(taskId ? "thread.back_to_task" : "thread.back_to_project_activities")}
            title={t(taskId ? "thread.back_to_task" : "thread.back_to_project_activities")}
            onClick={(event) => {
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              void navigateToAppPath(projectActivitiesHref);
            }}
          >
            <NavBack size={ICON.md} /><span>{t(taskId ? "thread.back_to_task" : "workspace.tab_activities")}</span>
          </a>
        ) : (
          <Button variant="ghost" className="mobile-back-button" type="button" aria-label={t("nav.threads")} onClick={onBackToThreads}>
            <NavThreads size={ICON.md} /><span>{t("nav.threads")}</span>
          </Button>
        )}
        <div className="chat-title-text">
          <h2 title={activeSession ? (activeSession.title?.trim() || activeSession.taskGoal) : undefined}>{activeSession ? (activeSession.title?.trim() || activeSession.taskGoal) : t("thread.new_thread")}</h2>
        {activeSession?.execution && activeSession.execution.phase !== "terminal" ? (
          <span className="chat-title-status" role="status">{t(`thread.execution_${activeSession.execution.phase}`)}{activeSession.deletionRequestedAt ? ` · ${t("thread.deletion_pending")}` : ""}</span>
        ) : null}
        </div>
      </div>
      {participants && participants.length > 1 ? (
        <AvatarStack
          className="chat-participants"
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
      ) : null}
      <div className="chat-tools">
        {spaceOpen && !taskId ? (
          <Button
            variant="icon"
            size="icon"
            type="button"
            className="chat-threadlist-button"
            tooltip={t("space.toggle_threads")}
            aria-expanded={!threadListHidden}
            onClick={onToggleThreadList}
          >
            <NavThreads size={ICON.md} />
          </Button>
        ) : null}
        <ArtifactNavButton
          artifactCount={artifactCount}
          inProject={Boolean(activeSession?.projectId)}
          onOpenArtifacts={onToggleSpace}
          expanded={spaceOpen}
          disabled={!activeSession}
        />
      </div>
    </header>
  );
}
