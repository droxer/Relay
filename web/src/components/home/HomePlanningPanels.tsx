"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { taskRef } from "../../lib/taskRef";
import type { HomeBlocker, UpcomingItem } from "../../lib/homePlan";
import type { RelayTaskListItem } from "../../types";
import type { HomeActions } from "./useHomeActions";
import { HomeLink } from "./HomePanels";

const UPCOMING_PREVIEW = 5;
const BLOCKER_PREVIEW = 3;

export function ReadyTask({ task, href, onOpen, onStart, focus = false }: {
  task: RelayTaskListItem;
  href: string;
  onOpen: () => void;
  onStart: HomeActions["startTask"];
  focus?: boolean;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [hasDispatch, setHasDispatch] = useState(false);
  const startInFlight = useRef(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const start = async () => {
    if (startInFlight.current) return;
    startInFlight.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      const result = await onStart(task);
      setHasDispatch(true);
      setOutcome(result.dispatch.message || t(`home.plan.start_${result.dispatch.state}`));
    } catch {
      setOutcome(t("home.plan.start_error"));
    } finally {
      startInFlight.current = false;
      setBusy(false);
    }
  };
  const due = task.dueDate ? ` · ${t("home.plan.due", { date: task.dueDate })}` : "";
  return (
    <div className={focus ? "home-focus" : "home-ready-row"}>
      {focus ? <div className="home-focus-heading"><h3>{t("home.plan.start_here")}</h3></div> : null}
      <div className="home-plan-row">
        <div className="home-plan-copy">
          <HomeLink href={href} onOpen={onOpen} className="home-item-title">
            <span className="home-item-ref">{taskRef(task)}</span>{task.title}
          </HomeLink>
          <p className="home-plan-meta">{t(`backlog.priorities.${task.priority}`)}{due}</p>
        </div>
        <Button size="dense" disabled={busy || hasDispatch} onClick={() => void start()}>{t("home.plan.start")}</Button>
      </div>
      {outcome ? (
        <p className="home-plan-outcome" role="status">
          {outcome} <HomeLink href={href} onOpen={onOpen} className="home-link">{t("home.open")}</HomeLink>
        </p>
      ) : null}
    </div>
  );
}

/** "Show all N" / "Show less" under a list cut to its preview. */
export function ShowAllToggle({ count, expanded, onToggle }: { count: number; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="dense" className="home-show-all" aria-expanded={expanded} onClick={onToggle}>
      {t(expanded ? "home.plan.show_less" : "home.plan.show_all", { count })}
    </Button>
  );
}

export function UpcomingPanel({ rows, today, hrefFor, onOpen }: {
  rows: UpcomingItem[];
  today: string;
  hrefFor: (row: UpcomingItem) => string;
  onOpen: (row: UpcomingItem) => void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const locale = i18n.resolvedLanguage ?? "en";
  const visible = expanded ? rows : rows.slice(0, UPCOMING_PREVIEW);
  const dateLabel = (day: string) => (day === today
    ? t("home.plan.today")
    : new Date(`${day}T12:00:00`).toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" }));
  const runTime = (row: UpcomingItem) => (row.kind === "automation" && row.task.routineNextRunAt
    ? ` · ${new Date(row.task.routineNextRunAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}`
    : "");
  return (
    <section className="home-section" aria-labelledby="home-upcoming-title">
      <header className="home-section-header">
        <h2 id="home-upcoming-title" className="home-section-title">{t("home.plan.upcoming")}</h2>
        <span className="home-section-count">{t("home.plan.seven_days")}</span>
      </header>
      <div className="home-panel">
        {visible.length ? (
          <ul className="home-plan-list">
            {visible.map((row, index) => {
              // A day's rows share one date: only the first one prints it.
              const firstOfDay = index === 0 || visible[index - 1].day !== row.day;
              return (
                <li key={row.key} data-continues={firstOfDay ? undefined : ""}>
                  <HomeLink className="home-agenda-row" href={hrefFor(row)} onOpen={() => onOpen(row)}>
                    <span className="home-agenda-date" data-today={row.day === today ? "" : undefined}>
                      {firstOfDay ? dateLabel(row.day) : <span className="sr-only">{dateLabel(row.day)}</span>}
                    </span>
                    <span className="home-plan-copy">
                      <span className="home-item-title">{row.task.title}</span>
                      <span className="home-plan-meta">{t(`home.plan.${row.kind}`)}{runTime(row)}</span>
                    </span>
                  </HomeLink>
                </li>
              );
            })}
          </ul>
        ) : <p className="home-plan-empty">{t("home.plan.nothing_upcoming")}</p>}
        {rows.length > UPCOMING_PREVIEW
          ? <ShowAllToggle count={rows.length} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
          : null}
        <p className="home-plan-note">{t("home.plan.schedule_note")}</p>
      </div>
    </section>
  );
}

export function BlockersPanel({ rows, onOpenTask, taskHref }: {
  rows: HomeBlocker[];
  onOpenTask: (id: string) => void;
  taskHref: (id: string) => string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (!rows.length) return null;
  const visible = expanded ? rows : rows.slice(0, BLOCKER_PREVIEW);
  return (
    <section className="home-section" aria-labelledby="home-blockers-title">
      <header className="home-section-header">
        <h2 id="home-blockers-title" className="home-section-title">{t("home.plan.shared_blockers")}</h2>
        <span className="home-section-count tnum">{rows.length}</span>
      </header>
      <ul className="home-panel home-blockers">
        {visible.map((row) => (
          <li key={row.id} className="home-blocker-row">
            {row.summary?.canOpen
              ? <HomeLink className="home-item-title" href={taskHref(row.id)} onOpen={() => onOpenTask(row.id)}>{row.summary.title}</HomeLink>
              : <span className="home-item-title">{row.summary?.title ?? t("home.plan.private_dependency")}</span>}
            <p className="home-plan-meta">
              {row.summary
                ? `${t(`backlog.statuses.${row.summary.status}`)} · ${row.summary.responsibleName ?? t("home.plan.other_user")}`
                : t("home.plan.details_private")}
            </p>
            <p className="home-blocker-dependents">
              {t("home.plan.holds_up")}{" "}
              {row.dependents.map((task, index) => (
                <span key={task.id}>
                  {index > 0 ? ", " : ""}
                  <HomeLink className="home-link" href={taskHref(task.id)} onOpen={() => onOpenTask(task.id)}>{taskRef(task)} {task.title}</HomeLink>
                </span>
              ))}
            </p>
          </li>
        ))}
      </ul>
      {rows.length > BLOCKER_PREVIEW
        ? <ShowAllToggle count={rows.length} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
        : null}
    </section>
  );
}
