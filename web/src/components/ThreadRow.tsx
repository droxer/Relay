import {
  ActionEdit,
  ActionPin,
  ActionRemove,
  ActionUnpin,
  AdminDelete,
  ICON,
  NavMore,
  NavRoutine,
} from "./icons";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { ThreadStatusBadge, threadStatusLabelKey } from "./ThreadStatusBadge";
import { TaskStatusIcon } from "./TaskStatusIcon";
import { OfflineBadge } from "./OfflineBadge";
import type { RelaySession, TaskStatus } from "../types";
import { canDeleteThread, threadLabel, threadRowMeta, type ThreadItem } from "../lib/threads";
import { formatThreadStamp } from "../lib/threadStamp";
import { queuedRun, queueWaitLabel, shownExecutionPhase } from "../lib/queuedRun";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMediaQuery } from "../hooks/useMediaQuery";

export type { ThreadItem };

type ThreadTone = "attn" | "run" | "queued" | "idle";

type ThreadRowProps = {
  item: ThreadItem;
  selected: boolean;
  runStartingInTranscript?: boolean;
  onSelect: (sessionId: string) => void;
  onRename?: (session: RelaySession) => void;
  onClose?: (sessionId: string, title?: string) => void;
  /** The row's attention tone, from the same groupThreads partition either
      mode runs. Task rows and active chats draw it before the title; rows
      with more to say also spell it out on the meta line. */
  tone: ThreadTone;
  /** "full" — the threads rail's row: title + stamp, over one plain meta
      line when the row has status or context to add. "nested" — a project
      folder's single-line sub-row: status icon + title + stamp. */
  layout?: "full" | "nested";
  /** The Project's Discussions list already supplies the Project context. */
  discussion?: boolean;
  onSetDiscussionPin?: (sessionId: string, pinned: boolean) => void;
  discussionPinPending?: boolean;
  discussionSelection?: { checked: boolean; disabled: boolean; onToggle: () => void };
  /** The rail's minute clock. The stamp reads it instead of Date.now() so the
      memoized row re-renders once a minute to keep "3m ago" honest, and never
      merely because its parent did. */
  now: number;
};

/* Memoized: the rail mounts dozens of rows and its parents re-render for
   reasons no row cares about. Every prop is stable when unchanged — items are
   carried forward by reuseThreadItems, handlers by useStableCallback. */
export const ThreadRow = memo(function ThreadRow({
  item, selected, runStartingInTranscript, onSelect, onRename, onClose, tone: suppliedTone, layout = "full",
  discussion = false, onSetDiscussionPin, discussionPinPending, discussionSelection, now,
}: ThreadRowProps) {
  const { t, i18n } = useTranslation();
  /* No hover on touch, so the hover-revealed pencil and cross would sit on
     every row for good — two small targets that cost the title a third of
     its width and put a delete one slip away from the row it ends. One
     overflow glyph holds both there. */
  const touch = useMediaQuery("(hover: none)");
  const { session } = item;
  // A run inside its queue grace reads as running everywhere on the row, in
  // step with the rail group groupThreads put it in.
  const reading = { nodeOffline: item.nodeOffline, now };
  const executionPhase = shownExecutionPhase(session, reading);
  const queued = queuedRun(session, reading);
  const tone = executionPhase === "unresponsive" || executionPhase === "recovery_required" ? "err"
    : queued ? "queued"
    : executionPhase && ["stopping", "finalizing"].includes(executionPhase) ? "attn" : suppliedTone;
  // Linked tasks retain their workflow icons; conversations have their own badge.
  const hasLifecycle = Boolean(item.origin);
  const label = threadLabel(session);
  const stamp = formatThreadStamp(session.updatedAt, i18n.language, now);
  const offlineLabel = item.nodeOffline ? t("thread.node_offline") : "";
  // Live Thread execution can advance before the linked Task is refreshed.
  const activePhase = executionPhase && executionPhase !== "terminal" ? executionPhase
    : !executionPhase && tone === "run" ? "running" : undefined;
  const iconStatus: TaskStatus = activePhase
    ? tone === "err" ? "blocked" : tone === "attn" ? "waiting_for_human" : activePhase === "queued" ? "queued" : "running"
    // The settled row still shows the linked Task's own lifecycle (e.g. Review).
    : item.origin?.status ?? (session.status === "failed" ? "blocked"
      : tone === "attn" ? "waiting_for_human"
      : session.status === "cancelled" ? "cancelled" : "done");
  const stateLabel = !hasLifecycle ? t(threadStatusLabelKey(session, reading))
    : activePhase ? t(`thread.execution_${activePhase}`)
    : item.origin?.status ? t(`backlog.statuses.${item.origin.status}`)
    : tone === "attn" ? t("thread.group_needs_you") : t("thread.group_idle");
  const projectName = discussion ? undefined : item.projectName ?? session.projectId;
  const projectLabel = projectName ? t("thread.project_indicator", { name: projectName }) : "";
  // A backlog task's thread inside a project already carries the project
  // indicator; a "Backlog" badge would only restate where it lives, so the
  // origin shows only for standalone tasks and routines.
  const showOrigin = Boolean(item.origin) && !(item.origin?.kind === "backlog" && projectName);
  const originLabel = item.origin && showOrigin
    ? t(item.origin.kind === "routine" ? "thread.origin_routine" : "thread.origin_backlog", { title: item.origin.title })
    : "";
  const rowLabel = [label, projectLabel, originLabel, offlineLabel, stateLabel, stamp].filter(Boolean).join(" · ");
  const deleteEnabled = canDeleteThread(item);
  const menuActions = (discussion || touch) && (onRename || onClose || onSetDiscussionPin);
  const PinIcon = session.discussionPinned ? ActionUnpin : ActionPin;

  // Live activity names the agent or the input it needs. Only linked work
  // keeps failure/cancellation labels after execution ends; standalone chats
  // return to a plain conversation row.
  // A queued run says how long it has waited, or that its computer is gone —
  // the one thing that would keep it waiting indefinitely.
  const queueWait = queued ? queueWaitLabel(queued.queuedAt, now, "minute") : "";
  const status: { text: string; tone: "attn" | "run" | "queued" | "err" | "idle" } | null =
    queued
      ? {
          tone: "queued",
          text: queued.cause === "offline"
            ? t("thread.queued_offline")
            : queueWait ? t("thread.queued_for", { duration: queueWait }) : t("thread.execution_queued"),
        }
      : executionPhase && executionPhase !== "terminal" && executionPhase !== "running"
      ? { tone: executionPhase === "starting" ? "run" : "attn", text: t(`thread.execution_${executionPhase}`) }
      : executionPhase === "running" || tone === "run"
      ? {
          tone: "run",
          // Named by the logical agent, never the executor kind: several
          // agents share one runtime, so "Claude is working" named nobody.
          text: item.runningAgentName
            ? t("thread.agent_working", { agent: item.runningAgentName })
            : t("thread.group_running"),
        }
      : tone === "attn"
        ? { tone: "attn", text: t("thread.statuses.waiting_for_human") }
        : (hasLifecycle || touch) && session.status === "failed"
          ? { tone: "err", text: t("thread.statuses.failed") }
          : (hasLifecycle || touch) && session.status === "cancelled"
            ? { tone: "idle", text: t("thread.statuses.cancelled") }
            : null;

  // Where the work lives, in words: its project, else the task or automation
  // that started it. One fact, never both — a project task's thread already
  // reads as the project's. A source named like the thread itself (every
  // automation run) would only repeat the title, so it reads as its kind.
  const originKind = item.origin
    ? t(item.origin.kind === "routine" ? "thread.origin_kind_routine" : "thread.origin_kind_backlog")
    : undefined;
  const originContext = item.origin && showOrigin
    ? (item.origin.title.trim() === label.trim() ? originKind : item.origin.title)
    : undefined;
  const context = projectName ?? originContext;
  const contextLabel = projectName ? projectLabel : originLabel;
  const visibleStatus = runStartingInTranscript && status?.tone === "run" ? null : status;
  const { subline } = threadRowMeta({ layout, hasStatus: Boolean(visibleStatus), hasContext: Boolean(context) });

  function handleClose() {
    if (discussion) onClose?.(session.id, label);
    else onClose?.(session.id);
  }

  const offlineMark = item.nodeOffline ? (
    <OfflineBadge className="conversation-offline" title={offlineLabel} />
  ) : null;

  return (
    <li
      className={`conversation-row rail-row list-virtual${layout === "nested" ? " nested" : ""}`}
      data-selected={selected || discussionSelection?.checked ? "true" : "false"}
      data-tone={tone}
    >
      {discussionSelection && (
        <span className="discussion-row-selection">
          {deleteEnabled && (
            <Checkbox
              checked={discussionSelection.checked}
              disabled={discussionSelection.disabled}
              aria-label={t("project.discussions_select_row", { name: label })}
              onCheckedChange={discussionSelection.onToggle}
            />
          )}
        </span>
      )}
      <Button variant="ghost"
        className="conversation-row-inner"
        type="button"
        aria-label={rowLabel}
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(session.id)}
      >
        <span className="conversation-copy">
          <span className="conversation-topline">
            {hasLifecycle ? <TaskStatusIcon status={iconStatus} />
              /* A chat whose subline states its status — or any phone row,
                 where a leading pill steals a third of the title's width —
                 keeps only the badge's tinted mark. */
              : <ThreadStatusBadge session={session} reading={reading} compact iconOnly={Boolean(discussion || touch || (status && (subline || !visibleStatus)))} />}
            <span className="conversation-name">
              {item.origin ? (
                /* An automation run carries the Automations nav glyph on its
                   ref: an occurrence is numbered like any issue (`#12`), so
                   without it a scheduled run reads as hand-filed work. */
                <span
                  className="conversation-ref tnum"
                  data-kind={item.origin.kind}
                  title={item.origin.kind === "routine" ? originKind : undefined}
                >
                  {item.origin.kind === "routine" ? <NavRoutine size={ICON.xs} aria-hidden="true" /> : null}
                  {item.origin.ref}
                </span>
              ) : null}
              <strong title={label}>{label}</strong>
              {/* A property of the thread itself, so it rides the title and
                  survives the hover swap that hides the timestamp. */}
              {offlineMark}
            </span>
            {stamp ? (
              <span className="conversation-stamp tnum">
                {stamp}
              </span>
            ) : null}
          </span>
          {subline ? (
            /* One muted line of words: status first, then where the work
               lives. The tone is drawn once, by the title's status icon. */
            <span className="conversation-subline">
              {visibleStatus ? (
                <span className="conversation-status" data-tone={visibleStatus.tone}>{visibleStatus.text}</span>
              ) : null}
              {context ? (
                <span
                  className={projectName ? "conversation-project" : "conversation-origin"}
                  data-kind={projectName ? undefined : item.origin?.kind}
                  title={contextLabel}
                >
                  {context}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </Button>
      {discussionSelection ? null : menuActions ? (
        <span className="conversation-row-actions">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="icon"
                  size="icon-xs"
                  className="conversation-more-btn"
                  type="button"
                  aria-label={t("thread.more_actions", { name: label })}
                >
                  <NavMore size={ICON.sm} aria-hidden="true" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {onSetDiscussionPin ? (
                <DropdownMenuItem
                  disabled={discussionPinPending || !deleteEnabled}
                  onClick={() => onSetDiscussionPin(session.id, !session.discussionPinned)}
                >
                  <PinIcon size={ICON.sm} aria-hidden="true" />
                  {t(session.discussionPinned ? "project.discussions_unpin" : "project.discussions_pin")}
                </DropdownMenuItem>
              ) : null}
              {onRename ? (
                <DropdownMenuItem onClick={() => onRename(session)}>
                  <ActionEdit size={ICON.sm} aria-hidden="true" />
                  {t("thread.rename")}
                </DropdownMenuItem>
              ) : null}
              {onClose ? (
                <DropdownMenuItem danger disabled={!deleteEnabled} onClick={handleClose}>
                  <AdminDelete size={ICON.sm} aria-hidden="true" />
                  {deleteEnabled ? t("thread.delete") : t("thread.delete_blocked")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      ) : (
        <span className="conversation-row-actions">
          {onRename ? (
            <Button variant="icon"
              size="icon-xs"
              className="conversation-rename-btn"
              type="button"
              tooltip={t("thread.rename")}
              onClick={() => onRename(session)}
            >
              <ActionEdit size={ICON.xs} />
            </Button>
          ) : null}
          {onClose ? (
            <Button variant="icon"
              size="icon-xs"
              danger
              className="conversation-remove-btn"
              type="button"
              tooltip={deleteEnabled ? t("thread.delete") : t("thread.delete_blocked")}
              disabled={!deleteEnabled}
              onClick={handleClose}
            >
              <ActionRemove size={ICON.xs} />
            </Button>
          ) : null}
        </span>
      )}
    </li>
  );
});
