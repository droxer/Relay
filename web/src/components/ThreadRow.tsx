import {
  ActionEdit,
  ActionRemove,
  AdminDelete,
  ICON,
  NavMore,
} from "./icons";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { StateMark, type StateShape, type StateTone } from "./StateMark";
import { OfflineBadge } from "./OfflineBadge";
import type { RelaySession } from "../types";
import { canDeleteThread, threadLabel, threadRowMeta, type ThreadItem } from "../lib/threads";
import { formatThreadStamp } from "../lib/threadStamp";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMediaQuery } from "../hooks/useMediaQuery";

export type { ThreadItem };

type ThreadTone = "attn" | "run" | "idle";

type ThreadRowProps = {
  item: ThreadItem;
  selected: boolean;
  onSelect: (sessionId: string) => void;
  onRename?: (session: RelaySession) => void;
  onClose?: (sessionId: string) => void;
  /** The row's attention tone, from the same groupThreads partition either
      mode runs. Every row draws it as a pip leading the title; rows with
      something more specific to say also spell it out on the meta line. */
  tone: ThreadTone;
  /** "full" — the threads rail's row: title + stamp, over one plain meta
      line when the row has status or context to add. "nested" — a project
      folder's single-line sub-row: pip + title + stamp. */
  layout?: "full" | "nested";
  /** The rail's minute clock. The stamp reads it instead of Date.now() so the
      memoized row re-renders once a minute to keep "3m ago" honest, and never
      merely because its parent did. */
  now: number;
};

/**
 * The rail's tone words in the app-wide vocabulary, so the pip obeys the one
 * shape grammar. `err` used to paint a solid --err here while every other
 * surface spent the hollow ring on failure and this one spent it on
 * `idle` — the ring meant "failed" one panel over and "settled" in the rail.
 * Failure takes the ring; a settled thread is out of play, which is `muted`.
 */
const PIP: Record<ThreadTone | "err", { tone: StateTone; shape?: StateShape }> = {
  attn: { tone: "warn" },
  run: { tone: "live" },
  err: { tone: "bad" },
  idle: { tone: "neutral", shape: "muted" },
};

/* Memoized: the rail mounts dozens of rows and its parents re-render for
   reasons no row cares about. Every prop is stable when unchanged — items are
   carried forward by reuseThreadItems, handlers by useStableCallback. */
export const ThreadRow = memo(function ThreadRow({ item, selected, onSelect, onRename, onClose, tone: suppliedTone, layout = "full", now }: ThreadRowProps) {
  const { t, i18n } = useTranslation();
  /* No hover on touch, so the hover-revealed pencil and cross would sit on
     every row for good — two small targets that cost the title a third of
     its width and put a delete one slip away from the row it ends. One
     overflow glyph holds both there. */
  const touch = useMediaQuery("(hover: none)");
  const { session } = item;
  const executionPhase = session.execution?.phase;
  const tone = executionPhase === "unresponsive" || executionPhase === "recovery_required" ? "err"
    : executionPhase && ["queued", "stopping", "finalizing"].includes(executionPhase) ? "attn" : suppliedTone;
  const label = threadLabel(session);
  const stamp = formatThreadStamp(session.updatedAt, i18n.language, now);
  const offlineLabel = item.nodeOffline ? t("thread.node_offline") : "";
  const stateLabel =
    executionPhase && executionPhase !== "terminal" ? t(`thread.execution_${executionPhase}`) : tone === "attn"
      ? t("thread.group_needs_you")
      : tone === "run"
        ? t("thread.group_running")
        : t("thread.group_idle");
  const projectName = item.projectName ?? session.projectId;
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

  // The meta line's status text. A live run names its agent; a thread
  // waiting on a decision or one that ended badly says so outright. Settled
  // (completed / merely idle) threads stay silent — the group header above
  // them already says "idle", and restating it on every row is noise. A
  // cancel keeps its words but takes the settled grey pip, not the failure
  // ring: it was the user's own call, not a fault.
  const status: { text: string; tone: "attn" | "run" | "err" | "idle" } | null =
    session.execution && session.execution.phase !== "terminal" && session.execution.phase !== "running"
      ? { tone: "attn", text: t(`thread.execution_${session.execution.phase}`) }
      : session.execution?.phase === "running" || tone === "run"
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
        : session.status === "failed"
          ? { tone: "err", text: t("thread.statuses.failed") }
          : session.status === "cancelled"
            ? { tone: "idle", text: t("thread.statuses.cancelled") }
            : null;

  // The pip follows the row's own status, not only the group it sorts into.
  // A failed thread files under "Idle" — it is not running and needs no
  // decision — so the group tone alone drew it with the same grey muted pip
  // as a thread that finished cleanly, and only the word "Failed" set them
  // apart. Failure takes the ring (see PIP); everything else keeps the group
  // tone, including an unresponsive run, which `tone` already marks as err.
  const pipTone = tone === "err" || status?.tone === "err" ? "err" : tone;

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
  const { subline } = threadRowMeta({ layout, hasStatus: Boolean(status), hasContext: Boolean(context) });

  function handleClose() {
    onClose?.(session.id);
  }

  const offlineMark = item.nodeOffline ? (
    <OfflineBadge className="conversation-offline" title={offlineLabel} />
  ) : null;

  return (
    <li
      className={`conversation-row rail-row list-virtual${layout === "nested" ? " nested" : ""}`}
      data-selected={selected ? "true" : "false"}
      data-tone={tone}
    >
      <Button variant="ghost"
        className="conversation-row-inner"
        type="button"
        aria-label={rowLabel}
        aria-current={selected ? "page" : undefined}
        onClick={() => onSelect(session.id)}
      >
        <span className="conversation-copy">
          <span className="conversation-topline">
            {/* Every row leads with its state, in the same column whatever
                the row goes on to say. A settled thread says nothing in
                words — it is the majority of the rail and used to be the one
                row with no state at all — and the rail no longer offers a
                filter to ask the question for you. */}
            <StateMark {...PIP[pipTone]} />
            <span className="conversation-name">
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
               lives. The tone is drawn once, by the title's pip. */
            <span className="conversation-subline">
              {status ? (
                <span className="conversation-status" data-tone={status.tone}>{status.text}</span>
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
      {touch && (onRename || onClose) ? (
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
