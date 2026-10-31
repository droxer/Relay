"use client";

import { useState, type ComponentType, type FormEvent, type ReactNode } from "react";
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
import { isQuestionPrompt, mayAllowAlways, permissionInputSummary } from "../../lib/permissionRequests";
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
  /** The Start here recommendation opens the record for its full context. */
  navigationOnly?: boolean;
  /** Called once the row's own action landed, so it can leave the list. */
  onResolved: () => void;
}

/** One "Up next" row: what it is, why it wants the person, and the actions
 *  that settle it in place. Open is always offered — the record holds the
 *  whole story when a one-click answer is not enough. */
export function HomeQueueItem({ item, actions, agentName, projectName, since, href, onOpen, onResolved, navigationOnly = false }: HomeQueueItemProps) {
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

  return (
    <li className="home-item" data-kind={item.kind} data-tone={tone} aria-busy={busy || undefined}>
      <span className="home-item-glyph" aria-hidden="true"><Icon size={ICON.sm} /></span>
      <div className="home-item-body">
        <a className="home-item-title" href={href} onClick={(event) => { if (isPlainClick(event)) { event.preventDefault(); onOpen(); } }}>
          {ref ? <span className="home-item-ref">{ref}</span> : null}
          {itemTitle(item, t)}
        </a>
        <p className="home-item-why">{itemWhy(item, t, agent)}</p>
        <p className="home-item-meta">
          <span className="home-item-kind">{kindLabel}</span>
          {project ? <span>{project}</span> : null}
          {agent ? <span>{agent}</span> : null}
          <span>{since}</span>
        </p>
        {navigationOnly ? (
          <Controls>
            <Button type="button" size="dense" onClick={onOpen}>
              {t(item.kind === "permission" || item.kind === "suggested" || (item.kind === "wait" && item.awaiting.sessionId) ? "home.open_thread" : "home.open")}
            </Button>
          </Controls>
        ) : <ItemControls item={item} actions={actions} busy={busy} run={run} onOpen={onOpen} />}
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

function ItemControls({ item, actions, busy, run, onOpen }: {
  item: HomeItem;
  actions: HomeActions;
  busy: boolean;
  run: (action: () => Promise<boolean>) => Promise<boolean>;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const open = (label = t("home.open")) => (
    <Button type="button" variant="outline" size="dense" disabled={busy} onClick={onOpen}>{label}</Button>
  );
  switch (item.kind) {
    case "permission": {
      // A runtime question wants written answers per question; its card in
      // the thread is where those are composed.
      if (isQuestionPrompt(item.request)) return <Controls>{open(t("home.answer_in_thread"))}</Controls>;
      const answer = (decision: "allow" | "deny", always?: boolean) =>
        void run(() => actions.answerPermission(item.session, item.request.id, decision, always));
      return (
        <Controls>
          <Button type="button" size="dense" disabled={busy} onClick={() => answer("allow")}>{t("home.allow")}</Button>
          {mayAllowAlways(item.request)
            ? <Button type="button" variant="outline" size="dense" disabled={busy} onClick={() => answer("allow", true)}>{t("home.always_allow")}</Button>
            : null}
          <Button type="button" variant="outline" size="dense" disabled={busy} onClick={() => answer("deny")}>{t("home.deny")}</Button>
        </Controls>
      );
    }
    case "wait": {
      const { awaiting } = item;
      const sessionId = awaiting.sessionId;
      if (!sessionId) return <Controls>{open()}</Controls>;
      const send = (text: string, approve?: boolean) =>
        run(() => actions.answerWait(sessionId, awaiting.questionId, text, approve));
      if (awaiting.kind === "approval") {
        return (
          <Controls>
            <Button type="button" size="dense" disabled={busy} onClick={() => void send(t("awaiting.choice_approve_reply"), true)}>
              {t("home.approve")}
            </Button>
            {open(t("home.review_first"))}
          </Controls>
        );
      }
      return (
        <>
          {awaiting.options.length ? (
            <Controls label={t("home.options_label")}>
              {awaiting.options.map((option) => (
                <Button key={option} type="button" variant="outline" size="dense" disabled={busy} onClick={() => void send(option)}>
                  {option}
                </Button>
              ))}
            </Controls>
          ) : null}
          <AnswerForm busy={busy} onSend={send} />
        </>
      );
    }
    case "review":
      return (
        <Controls>
          <Button type="button" size="dense" disabled={busy} onClick={() => void run(() => actions.acceptReview(item.task))}>
            {t("home.accept")}
          </Button>
          {open(t("home.review_first"))}
        </Controls>
      );
    case "suggested":
      return (
        <Controls>
          <Button type="button" variant="outline" size="dense" disabled={busy} onClick={() => void run(() => actions.sendStep(item.session, item.step))}>
            {t("home.send_step")}
          </Button>
        </Controls>
      );
    case "offline":
      return <Controls>{open(t("home.view_computer"))}</Controls>;
    case "untriaged":
      return <Controls>{open(t("home.triage"))}</Controls>;
    default:
      return <Controls>{open()}</Controls>;
  }
}

function Controls({ children, label }: { children: ReactNode; label?: string }) {
  return <div className="home-item-actions" role="group" aria-label={label}>{children}</div>;
}

function AnswerForm({ busy, onSend }: { busy: boolean; onSend: (text: string) => Promise<boolean> }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const answer = text.trim();
    if (!answer) return;
    if (await onSend(answer)) setText("");
  };
  return (
    <form className="home-item-answer" onSubmit={(event) => void submit(event)}>
      <input
        className="home-item-answer-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t("home.answer_placeholder")}
        aria-label={t("home.answer_label")}
        disabled={busy}
      />
      <Button type="submit" size="dense" disabled={busy || !text.trim()}>{t("home.send")}</Button>
    </form>
  );
}

function isPlainClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

type T = (key: string, options?: Record<string, unknown>) => string;

function describe(item: HomeItem, t: T): { Icon: ComponentType<GlyphProps>; tone: Tone; kindLabel: string } {
  switch (item.kind) {
    case "permission":
      return { Icon: AdminLocked, tone: "err", kindLabel: t("home.kind.permission") };
    case "wait":
      if (item.awaiting.kind === "approval") return { Icon: ActionApprove, tone: "warn", kindLabel: t("home.kind.approval") };
      if (item.awaiting.kind === "question") return { Icon: ActionPrompt, tone: "warn", kindLabel: t("home.kind.question") };
      return { Icon: StatusWarn, tone: "warn", kindLabel: t(`home.kind.${item.awaiting.kind}`) };
    case "review":
      return { Icon: StatusOk, tone: "warn", kindLabel: t("home.kind.review") };
    case "blocked":
      return { Icon: StatusError, tone: "err", kindLabel: t("home.kind.blocked") };
    case "offline":
      return { Icon: NodeOffline, tone: "warn", kindLabel: t("home.kind.offline") };
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
