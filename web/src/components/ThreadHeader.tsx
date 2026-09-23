import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RelaySession } from "../types";
import {
  ICON,
  NavThreads,
} from "./icons";
import { ArtifactNavButton } from "./ArtifactNavButton";
import { Button } from "@/components/ui/button";

export function ThreadHeader({ taskThread = false, activeSession, facts, artifactCount, spaceOpen, threadListHidden, onToggleSpace, onToggleThreadList, onBackToThreads }: {
  /** A thread opened from a backlog task or a routine run. */
  taskThread?: boolean;
  activeSession: RelaySession | undefined;
  /** The thread's coordinates — the room, the machine, the project, the last
   *  movement — drawn as marks by `ThreadMeta`. They ride the header's own
   *  row rather than a band beneath it: a record page can spend a row on its
   *  facts, a conversation cannot, and the row it used to spend came out of
   *  the transcript. The room used to be drawn here too, as a second bare
   *  face stack beside the facts; it is part of the marks now. */
  facts?: ReactNode;
  artifactCount: number;
  spaceOpen: boolean;
  threadListHidden: boolean;
  onToggleSpace: () => void;
  onToggleThreadList: () => void;
  onBackToThreads: () => void;
}) {
  const { t } = useTranslation();
  /* No way back lives in this row anymore. The project fact in `ThreadMeta`
     is a link to the project, which is the only place the reader was ever
     going — and it is the project's NAME, not a nameless "back" arrow that
     had to be read to find out where it led. A task thread gets nothing
     either: its task is one browser-back away and named in the thread's own
     origin line. What stays is the phone-only return to the thread list,
     which the mobile top bar needs because the rail is off screen there. */
  return (
    <header className="chat-header">
      <div className="chat-title">
        <Button variant="ghost" className="mobile-back-button" type="button" aria-label={t("nav.threads")} onClick={onBackToThreads}>
          <NavThreads size={ICON.md} /><span>{t("nav.threads")}</span>
        </Button>
        <div className="chat-title-text">
          <h2 title={activeSession ? (activeSession.title?.trim() || activeSession.taskGoal) : undefined}>{activeSession ? (activeSession.title?.trim() || activeSession.taskGoal) : t("thread.new_thread")}</h2>
        {activeSession?.execution && activeSession.execution.phase !== "terminal" ? (
          <span className="chat-title-status" role="status">{t(`thread.execution_${activeSession.execution.phase}`)}{activeSession.deletionRequestedAt ? ` · ${t("thread.deletion_pending")}` : ""}</span>
        ) : null}
        </div>
      </div>
      {facts ? <div className="chat-meta">{facts}</div> : null}
      <div className="chat-tools">
        {spaceOpen && !taskThread ? (
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
