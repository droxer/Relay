import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { EmployeeAgent, RelaySession } from "../types";
import {
  ICON,
  NavThreads,
} from "./icons";
import { ArtifactNavButton } from "./ArtifactNavButton";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";
import { Button } from "@/components/ui/button";

export function ThreadHeader({ activeSession, onRetryExecutionRecovery, participants, artifactCount, spaceOpen, threadListHidden, onToggleSpace, onToggleThreadList, onBackToThreads }: {
  activeSession: RelaySession | undefined;
  onRetryExecutionRecovery?: () => Promise<void>;
  /** Agents in the room, in join order. Shown only once a thread has more
   *  than one — a solo thread already names its agent in the composer. */
  participants?: EmployeeAgent[];
  artifactCount: number;
  spaceOpen: boolean;
  threadListHidden: boolean;
  onToggleSpace: () => void;
  onToggleThreadList: () => void;
  onBackToThreads: () => void;
}) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  return (
    <header className="chat-header">
      <div className="chat-title">
        <Button variant="ghost" className="mobile-back-button" type="button" aria-label={t("nav.threads")} onClick={onBackToThreads}>
          <NavThreads size={ICON.md} /><span>{t("nav.threads")}</span>
        </Button>
        <div className="chat-title-text">
          <h2 title={activeSession ? (activeSession.title?.trim() || activeSession.taskGoal) : undefined}>{activeSession ? (activeSession.title?.trim() || activeSession.taskGoal) : t("thread.new_thread")}</h2>
        {activeSession?.execution && activeSession.execution.phase !== "terminal" ? (
          <span className="text-xs text-muted-foreground truncate" role="status">{t(`thread.execution_${activeSession.execution.phase}`)}{activeSession.deletionRequestedAt ? ` · ${t("thread.deletion_pending")}` : ""}</span>
        ) : null}
        </div>
      </div>
      {participants && participants.length > 1 ? (
        <div className="chat-participants" aria-label={t("thread.participants")}>
          {participants.map((participant) => (
            <span key={participant.id} className="chat-participant" title={participant.displayName}>
              <ProfileImage
                src={participant.profileImageUrl}
                alt=""
                fallback={<IdentityMark kind="agent" />}
                className="chat-participant-mark"
              />
              <span translate="no">{participant.displayName}</span>
            </span>
          ))}
        </div>
      ) : null}
      <div className="chat-tools">
        {activeSession?.execution?.blockingReason === "finalization_failed" && onRetryExecutionRecovery ? (
          <Button variant="ghost" disabled={retrying} onClick={async () => {
            setRetrying(true); setRetryFailed(false);
            try { await onRetryExecutionRecovery(); } catch { setRetryFailed(true); }
            finally { setRetrying(false); }
          }}>{t("thread.retry_recovery")}</Button>
        ) : null}
        {retryFailed ? <span role="alert">{t("thread.recovery_failed")}</span> : null}
        {spaceOpen ? (
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
