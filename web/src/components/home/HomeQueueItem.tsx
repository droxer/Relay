"use client";

import { useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  ActionApprove,
  ActionCalendar,
  ActionPrompt,
  ActionRoute,
  ActionSnooze,
  AdminInbox,
  AdminLocked,
  ICON,
  NodeOffline,
  StatusError,
  StatusOk,
  StatusWarn,
  type GlyphProps,
} from "../icons";
import { computerName } from "../../lib/createAgent";
import type { HomeItem } from "../../lib/homeQueue";
import { homeItemSummary } from "../../lib/homeItemSummary";
import { permissionInputSummary } from "../../lib/permissionRequests";
import { taskRef } from "../../lib/taskRef";
import type { HomeActions } from "./useHomeActions";

type Tone = "err" | "warn" | "live" | "mute";

export interface HomeQueueItemProps {
  item: HomeItem;
  actions: HomeActions;
  agentName: (agentId: string | undefined, executor?: string) => string | null;
  projectName: (projectId: string | undefined) => string | null;
  /** Relative "since" stamp, already in the reader's language. */
  since: string;
  href: string;
  onOpen: () => void;
  /** The Start here recommendation gets the filled button. */
  primary?: boolean;
  /** Called once the row's snooze landed, so it can leave the list. */
  onResolved: () => void;
}

/** One "Up next" row: what it is, why it wants the person, and a way to the
 *  thread or record where it is settled. Only snoozing happens in place. */
export function HomeQueueItem({ item, actions, agentName, projectName, since, href, onOpen, onResolved, primary = false }: HomeQueueItemProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<boolean>) => {
    setBusy(true);
    const landed = await action();
    setBusy(false);
    if (landed) onResolved();
    return landed;
  };
  const { Icon, tone, kindLabel } = describe(item, t);
  const project = projectName(item.projectId);
  const agent = itemAgent(item, agentName);
  const ref = itemRef(item);
  const title = itemTitle(item, t);
  const why = itemWhy(item, t, agent);

  return (
    <li className="home-item" data-kind={item.kind} data-tone={tone} aria-busy={busy || undefined}>
      <span className="home-item-glyph" aria-hidden="true"><Icon size={ICON.sm} /></span>
      <div className="home-item-body">
        <a className="home-item-title" href={href} title={title} onClick={(event) => { if (isPlainClick(event)) { event.preventDefault(); onOpen(); } }}>
          {ref ? <span className="home-item-ref">{ref}</span> : null}
          {homeItemSummary(title)}
        </a>
        <p className="home-item-why" title={why}>{homeItemSummary(why)}</p>
        <p className="home-item-meta">
          <span className="home-item-kind">{kindLabel}</span>
          {project ? <span>{project}</span> : null}
          {agent ? <span>{agent}</span> : null}
          <span>{since}</span>
        </p>
        {/* Only the Start here row names its way forward as a button. Every
            other row's title already links to the same place, and a bordered
            Open under each one stacked a column of identical buttons. */}
        {primary ? (
          <div className="home-item-actions" role="group">
            <Button type="button" size="dense" disabled={busy} onClick={onOpen}>
              {t(openLabel(item))}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="home-item-trail">
        <Button
          type="button"
          variant="ghost"
          size="dense"
          className="home-snooze"
          disabled={busy}
          onClick={() => void run(() => actions.snooze(item))}
          title={t("home.snooze_hint")}
          aria-label={t("home.snooze")}
        >
          <ActionSnooze size={ICON.sm} aria-hidden="true" />
          <span className="home-snooze-label">{t("home.snooze")}</span>
        </Button>
      </div>
    </li>
  );
}

/** The Start here row's control: where its answer is given. A row never
 *  answers, approves, or sends from Home; the thread or record it opens
 *  shows the whole story before the person acts. */
function openLabel(item: HomeItem): string {
  switch (item.kind) {
    case "permission":
    case "suggested":
      return "home.open_thread";
    case "wait":
      return item.awaiting.sessionId ? "home.open_thread" : "home.open";
    case "offline":
      return "home.view_computer";
    case "untriaged":
      return "home.triage";
    default:
      return "home.open";
  }
}

function isPlainClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

type T = (key: string, options?: Record<string, unknown>) => string;

function describe(item: HomeItem, t: T): { Icon: ComponentType<GlyphProps>; tone: Tone; kindLabel: string } {
  switch (item.kind) {
    case "permission":
      // Asking is not failing: a prompt wants its person, like every needs-you item.
      return { Icon: AdminLocked, tone: "warn", kindLabel: t("home.kind.permission") };
    case "wait":
      if (item.awaiting.kind === "approval") return { Icon: ActionApprove, tone: "warn", kindLabel: t("home.kind.approval") };
      if (item.awaiting.kind === "question") return { Icon: ActionPrompt, tone: "warn", kindLabel: t("home.kind.question") };
      return { Icon: StatusWarn, tone: "warn", kindLabel: t(`home.kind.${item.awaiting.kind}`) };
    case "review":
      return { Icon: StatusOk, tone: "warn", kindLabel: t("home.kind.review") };
    case "blocked":
      return { Icon: StatusError, tone: "err", kindLabel: t("home.kind.blocked") };
    case "offline":
      return { Icon: NodeOffline, tone: "err", kindLabel: t("home.kind.offline") };
    case "overdue":
      return { Icon: ActionCalendar, tone: "warn", kindLabel: t("home.kind.overdue") };
    case "untriaged":
      return { Icon: AdminInbox, tone: "mute", kindLabel: t("home.kind.untriaged") };
    case "suggested":
      return { Icon: ActionRoute, tone: "mute", kindLabel: t("home.kind.suggested") };
  }
}

function itemRef(item: HomeItem): string | null {
  return "task" in item ? taskRef(item.task) : null;
}

function itemTitle(item: HomeItem, t: T): string {
  switch (item.kind) {
    case "permission":
    case "suggested":
      return item.session.title || item.session.taskGoal || t("home.untitled_thread");
    case "offline":
      return computerName(item.node);
    case "untriaged":
      return t("home.untriaged_title", { count: item.tasks.length });
    default:
      return item.task.title;
  }
}

function itemAgent(item: HomeItem, agentName: HomeQueueItemProps["agentName"]): string | null {
  if (item.kind === "permission") return agentName(item.request.logicalAgentId, item.request.agent);
  if ("task" in item && item.task.assignedAgentId) return agentName(item.task.assignedAgentId);
  return null;
}

function itemWhy(item: HomeItem, t: T, agent: string | null): string {
  switch (item.kind) {
    case "permission": {
      const subject = permissionInputSummary(item.request.input);
      const who = agent ?? t("home.an_agent");
      return subject
        ? t("home.why.permission_with_input", { agent: who, tool: item.request.toolName, input: subject })
        : t("home.why.permission", { agent: who, tool: item.request.toolName });
    }
    case "wait":
      return item.awaiting.text ?? t(`home.why.${item.awaiting.kind}`);
    case "review":
      return t("home.why.review");
    case "blocked":
      return item.task.blockerReason
        || (item.task.waitingOn?.length ? t("home.why.waiting_on", { count: item.task.waitingOn.length }) : t("home.why.blocked"));
    case "offline":
      return t("home.why.offline", { count: item.waitingToStart });
    case "overdue":
      return t("home.why.overdue", { date: item.task.dueDate });
    case "untriaged":
      return t("home.why.untriaged");
    case "suggested":
      return t("home.why.suggested", { step: item.step });
  }
}
