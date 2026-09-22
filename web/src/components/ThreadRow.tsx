import {
  ActionEdit,
  ActionRemove,
  ICON,
  NavBacklog,
  NavProjects,
  NavRoutine,
  NodeOffline,
} from "./icons";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { StateMark, type StateShape, type StateTone } from "./StateMark";
import type { RelaySession } from "../types";
import { canDeleteThread, sessionAgents, threadLabel, threadRowMeta, type ThreadItem } from "../lib/threads";
import { formatThreadStamp } from "../lib/threadStamp";
import { agentLabel } from "../lib/plan";
import { AgentMark } from "./AgentMark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IdentityMark } from "./IdentityMark";
import { ProfileImage } from "./ProfileImagePicker";

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
  /** "full" — the threads rail's two-line row: title + stamp over a status /
      agent meta line. "nested" — a project folder's single-line sub-row:
      pip + title + stamp, subordinate to the folder name. */
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
  const runningAgent = item.runningAgent ?? (session.status === "running" ? session.currentAgent : undefined);
  const status: { text: string; tone: "attn" | "run" | "err" | "idle" } | null =
    session.execution && session.execution.phase !== "terminal"
      ? { tone: session.execution.phase === "running" ? "run" : "attn", text: t(`thread.execution_${session.execution.phase}`) }
      : tone === "run"
      ? {
          tone: "run",
          text: runningAgent
            ? t("thread.agent_working", { agent: agentLabel(runningAgent) })
            : t("thread.group_running"),
        }
      : tone === "attn"
        ? { tone: "attn", text: t("thread.statuses.waiting_for_human") }
        : session.status === "failed"
          ? { tone: "err", text: t("thread.statuses.failed") }
          : session.status === "cancelled"
            ? { tone: "idle", text: t("thread.statuses.cancelled") }
            : null;

  // Who is in the thread's room, drawn as faces — the same fact the header's
  // participant stack shows. Threads whose room never resolved (older
  // sessions, deleted agents) fall back to the runtime marks that used to be
  // the row's only identity. Either way the cluster is decorative: the
  // running agent is named in the status text and the full set reads from
  // the title tooltip.
  const participants = item.participants ?? [];
  const runtimeAgents = sessionAgents(session);
  const agentsTitle = (participants.length > 0
    ? participants.map((agent) => agent.displayName)
    : runtimeAgents.map(agentLabel)
  ).join(", ");
  // Where the cluster goes, and whether the row earns a second line at all.
  const { subline, inlineAgents } = threadRowMeta({
    layout,
    hasStatus: Boolean(status),
    hasOrigin: Boolean(item.origin || projectName),
    agentCount: participants.length || runtimeAgents.length,
  });
  const agentCluster = participants.length > 0 ? (
    <span className="conversation-agents" title={agentsTitle} aria-hidden="true">
      {participants.map((agent) => (
        <span key={agent.id} className="conversation-agent-face" title={agent.displayName}>
          <ProfileImage src={agent.profileImageUrl} alt="" fallback={<IdentityMark kind="agent" />} />
        </span>
      ))}
    </span>
  ) : runtimeAgents.length > 0 ? (
    <span className="conversation-agents" title={agentsTitle} aria-hidden="true">
      {runtimeAgents.map((agent) => (
        <AgentMark key={agent} agent={agent} size={ICON.xs} />
      ))}
    </span>
  ) : null;

  function handleClose() {
    onClose?.(session.id);
  }

  const offlineMark = item.nodeOffline ? (
    <span
      className="conversation-offline"
      role="img"
      aria-label={offlineLabel}
      title={offlineLabel}
    >
      <NodeOffline size={ICON.xs} />
    </span>
  ) : null;

  // Which backlog task or routine started the thread, in words: a kind badge
  // ("Backlog" / "Routine") and, on full rows, the source's name beside it.
  // Nested rows are single-line, so they carry the badge alone and the name
  // reads from its tooltip. The row's aria-label already speaks both. A
  // project task's thread skips this — its project badge says it instead.
  const OriginGlyph = item.origin?.kind === "routine" ? NavRoutine : NavBacklog;
  const originBadge = item.origin && showOrigin ? (
    <Badge className="conversation-origin-kind" data-kind={item.origin.kind} title={originLabel} aria-hidden="true">
      <OriginGlyph size={ICON.xs} />
      {t(item.origin.kind === "routine" ? "thread.origin_kind_routine" : "thread.origin_kind_backlog")}
    </Badge>
  ) : null;

  const projectBadge = projectName ? (
    <Badge className="conversation-project" title={projectLabel} aria-hidden="true">
      <NavProjects size={ICON.xs} /><span>{projectName}</span>
    </Badge>
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
            <StateMark {...PIP[tone]} />
            <span className="conversation-name">
              <strong>{label}</strong>
              {/* The offline badge rides the title in both layouts: it is a
                  property of the thread itself, and the name line survives
                  the hover swap that hides the timestamp. */}
              {offlineMark}
              {/* A settled row has no status line to hang the marks under, so
                  they ride here rather than keeping a second line alive for
                  one decorative glyph. */}
              {inlineAgents ? agentCluster : null}
              {layout === "nested" ? <>{projectBadge}{originBadge}</> : null}
            </span>
            {stamp ? (
              <span className="conversation-stamp tnum">
                {stamp}
              </span>
            ) : null}
          </span>
          {subline ? (
            <span className="conversation-subline">
              {projectBadge}
              {/* Words only: the tone is drawn once, by the title's pip. Two
                  pips a line apart said the same thing twice — the mistake
                  the group labels already dropped their own pip over. */}
              {status ? (
                <span className="conversation-status" data-tone={status.tone}>
                  <span>{status.text}</span>
                </span>
              ) : null}
              {item.origin && showOrigin ? (
                <span className="conversation-origin" data-kind={item.origin.kind}>
                  {originBadge}
                  <span className="conversation-origin-name">{item.origin.title}</span>
                </span>
              ) : null}
              {inlineAgents ? null : agentCluster}
            </span>
          ) : null}
        </span>
      </Button>
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
    </li>
  );
});
