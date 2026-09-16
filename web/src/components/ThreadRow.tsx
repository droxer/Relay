import {
  ActionEdit,
  ActionRemove,
  ICON,
  NavBacklog,
  NavRoutine,
  NodeOffline,
} from "./icons";
import { useTranslation } from "react-i18next";
import { StateMark, type StateShape, type StateTone } from "./StateMark";
import type { RelaySession } from "../types";
import { canDeleteThread, sessionAgents, threadLabel, threadRowMeta, type ThreadItem } from "../lib/threads";
import { agentLabel } from "../lib/plan";
import { AgentMark } from "./AgentMark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type { ThreadItem };

function relativeTime(iso: string | undefined, locale: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.round(diff / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
  if (sec < 60) return formatter.format(-sec, "second");
  const min = Math.round(sec / 60);
  if (min < 60) return formatter.format(-min, "minute");
  const hr = Math.round(min / 60);
  if (hr < 24) return formatter.format(-hr, "hour");
  const day = Math.round(hr / 24);
  if (day < 7) return formatter.format(-day, "day");
  const wk = Math.round(day / 7);
  if (wk < 5) return formatter.format(-wk, "week");
  const mo = Math.round(day / 30);
  if (mo < 12) return formatter.format(-mo, "month");
  return formatter.format(-Math.round(day / 365), "year");
}

type ThreadTone = "attn" | "run" | "idle";

type ThreadRowProps = {
  item: ThreadItem;
  selected: boolean;
  onSelect: (sessionId: string) => void;
  onRename?: (session: RelaySession) => void;
  onClose?: (sessionId: string) => void;
  /** The row's attention tone, from the same groupThreads partition either
      mode runs. Full rows speak it as a status line; nested rows (no group
      headers above them) carry it as their own pip. */
  tone: ThreadTone;
  /** "full" — the threads rail's two-line row: title + stamp over a status /
      agent meta line. "nested" — a project folder's single-line sub-row:
      pip + title + stamp, subordinate to the folder name. */
  layout?: "full" | "nested";
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

export function ThreadRow({ item, selected, onSelect, onRename, onClose, tone: suppliedTone, layout = "full" }: ThreadRowProps) {
  const { t, i18n } = useTranslation();
  const { session } = item;
  const executionPhase = session.execution?.phase;
  const tone = executionPhase === "unresponsive" || executionPhase === "recovery_required" ? "err"
    : executionPhase && ["queued", "stopping", "finalizing"].includes(executionPhase) ? "attn" : suppliedTone;
  const label = threadLabel(session);
  const stamp = relativeTime(session.updatedAt, i18n.language);
  const offlineLabel = item.nodeOffline ? t("thread.node_offline") : "";
  const stateLabel =
    executionPhase && executionPhase !== "terminal" ? t(`thread.execution_${executionPhase}`) : tone === "attn"
      ? t("thread.group_needs_you")
      : tone === "run"
        ? t("thread.group_running")
        : t("thread.group_idle");
  const originLabel = item.origin
    ? t(item.origin.kind === "routine" ? "thread.origin_routine" : "thread.origin_backlog", { title: item.origin.title })
    : "";
  const rowLabel = [label, originLabel, offlineLabel, stateLabel, stamp].filter(Boolean).join(" · ");
  const deleteEnabled = canDeleteThread(item);

  // The meta line's status text. A live run names its agent; a thread
  // waiting on a decision or one that ended badly says so outright. Settled
  // (completed / merely idle) threads stay silent — the group header above
  // them already says "idle", and restating it on every row is noise.
  const runningAgent = item.runningAgent ?? (session.status === "running" ? session.currentAgent : undefined);
  const status: { text: string; tone: "attn" | "run" | "err" } | null =
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
            ? { tone: "err", text: t("thread.statuses.cancelled") }
            : null;

  // Who has worked the thread, as a mark cluster — the row's only identity
  // beyond its title. The cluster is decorative: the running agent is named
  // in the status text, and the full set reads from the title tooltip.
  const agents = sessionAgents(session);
  const agentsTitle = agents.map(agentLabel).join(", ");
  // Where the cluster goes, and whether the row earns a second line at all.
  const { subline, inlineAgents } = threadRowMeta({
    layout,
    hasStatus: Boolean(status),
    hasOrigin: Boolean(item.origin),
    agentCount: agents.length,
  });
  const agentCluster = agents.length > 0 ? (
    <span className="conversation-agents" title={agentsTitle} aria-hidden="true">
      {agents.map((agent) => (
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
  // reads from its tooltip. The row's aria-label already speaks both.
  const OriginGlyph = item.origin?.kind === "routine" ? NavRoutine : NavBacklog;
  const originBadge = item.origin ? (
    <Badge className="conversation-origin-kind" data-kind={item.origin.kind} title={originLabel} aria-hidden="true">
      <OriginGlyph size={ICON.xs} />
      {t(item.origin.kind === "routine" ? "thread.origin_kind_routine" : "thread.origin_kind_backlog")}
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
            {/* Nested rows have no group header above them, so each carries
                its own state pip; full rows speak state in the meta line. */}
            {layout === "nested" ? (
              <StateMark {...PIP[tone]} />
            ) : null}
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
              {layout === "nested" ? originBadge : null}
            </span>
            {stamp ? (
              <span className="conversation-stamp tnum">
                {stamp}
              </span>
            ) : null}
          </span>
          {subline ? (
            <span className="conversation-subline">
              {status ? (
                <span className="conversation-status" data-tone={status.tone}>
                  <StateMark {...PIP[status.tone]} />
                  <span>{status.text}</span>
                </span>
              ) : null}
              {item.origin ? (
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
}
