"use client";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { taskRef } from "../../lib/taskRef";
import type { HomeBlocker, UpcomingItem } from "../../lib/homePlan";
import type { RelayTaskListItem } from "../../types";
import type { HomeActions } from "./useHomeActions";
import { HomeLink } from "./HomePanels";

export function ReadyTask({ task, href, onOpen, onStart, focus = false }: {
  task: RelayTaskListItem; href: string; onOpen: () => void; onStart: HomeActions["startTask"]; focus?: boolean;
}) {
  const {t} = useTranslation();
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
  return <div className={focus ? "home-focus" : "home-ready-row"}>
    {focus ? <div className="home-focus-heading"><h3>{t("home.plan.start_here")}</h3></div> : null}
    <div className="home-plan-row">
      <div className="home-plan-copy">
        <HomeLink href={href} onOpen={onOpen} className="home-item-title"><span className="home-item-ref">{taskRef(task)}</span>{task.title}</HomeLink>
        <p className="home-plan-meta">{t(`backlog.priorities.${task.priority}`)}{task.dueDate ? ` · ${t("home.plan.due",{date:task.dueDate})}` : ""}</p>
      </div>
      <Button size="dense" disabled={busy || hasDispatch} onClick={() => void start()}>{t("home.plan.start")}</Button>
    </div>
    {outcome ? <p className="home-plan-outcome" role="status">{outcome} <HomeLink href={href} onOpen={onOpen} className="home-link">{t("home.open")}</HomeLink></p> : null}
  </div>;
}

export function UpcomingPanel({ rows, today, hrefFor, onOpen }: {
  rows: UpcomingItem[]; today: string; hrefFor: (row: UpcomingItem) => string; onOpen: (row: UpcomingItem) => void;
}) {
  const {t, i18n} = useTranslation();
  const [expanded,setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0,5);
  const dateLabel = (day:string) => day === today ? t("home.plan.today") : new Date(`${day}T12:00:00`).toLocaleDateString(i18n.resolvedLanguage ?? "en",{weekday:"short",month:"short",day:"numeric"});
  return <section className="home-section" aria-labelledby="home-upcoming-title">
    <header className="home-section-header"><h2 id="home-upcoming-title" className="home-section-title">{t("home.plan.upcoming")}</h2><span className="home-section-count">{t("home.plan.seven_days")}</span></header>
    <div className="home-panel">
      {visible.length ? <ul className="home-plan-list">{visible.map(row => <li key={row.key}>
        <HomeLink className="home-agenda-row" href={hrefFor(row)} onOpen={() => onOpen(row)}>
          <span className="home-agenda-date" data-today={row.day===today ? "" : undefined}>{dateLabel(row.day)}</span>
          <span className="home-plan-copy"><span className="home-item-title">{row.task.title}</span><span className="home-plan-meta">{t(`home.plan.${row.kind}`)}{row.kind === "automation" && row.task.routineNextRunAt ? ` · ${new Date(row.task.routineNextRunAt).toLocaleTimeString(i18n.resolvedLanguage ?? "en",{hour:"numeric",minute:"2-digit"})}` : ""}</span></span>
        </HomeLink>
      </li>)}</ul> : <p className="home-plan-empty">{t("home.plan.nothing_upcoming")}</p>}
      {rows.length>5 ? <Button variant="ghost" size="dense" onClick={()=>setExpanded(!expanded)}>{t(expanded ? "home.plan.show_less" : "home.plan.show_all",{count:rows.length})}</Button> : null}
      <p className="home-plan-note">{t("home.plan.schedule_note")}</p>
    </div>
  </section>;
}

export function BlockersPanel({ rows, onOpenTask, taskHref }: {
 rows: HomeBlocker[]; onOpenTask: (id:string)=>void; taskHref:(id:string)=>string;
}) {
 const {t}=useTranslation();const [expanded,setExpanded]=useState(false);
 if(!rows.length)return null;
 return <section className="home-section" aria-labelledby="home-blockers-title">
   <header className="home-section-header"><h2 id="home-blockers-title" className="home-section-title">{t("home.plan.shared_blockers")}</h2><span className="home-section-count tnum">{rows.length}</span></header>
   <ul className="home-panel home-blockers">{(expanded?rows:rows.slice(0,3)).map(row=><li key={row.id} className="home-blocker-row">
     {row.summary?.canOpen ? <HomeLink className="home-item-title" href={taskHref(row.id)} onOpen={()=>onOpenTask(row.id)}>{row.summary.title}</HomeLink> : <span className="home-item-title">{row.summary?.title ?? t("home.plan.private_dependency")}</span>}
     <p className="home-plan-meta">{row.summary ? `${t(`backlog.statuses.${row.summary.status}`)} · ${row.summary.responsibleName ?? t("home.plan.other_user")}` : t("home.plan.details_private")}</p>
     <p className="home-blocker-dependents">{t("home.plan.holds_up")} {row.dependents.map((task,i)=><span key={task.id}>{i>0 ? ", " : ""}<HomeLink className="home-link" href={taskHref(task.id)} onOpen={()=>onOpenTask(task.id)}>{taskRef(task)} {task.title}</HomeLink></span>)}</p>
   </li>)}</ul>
   {rows.length>3 ? <Button variant="ghost" size="dense" onClick={()=>setExpanded(!expanded)}>{t(expanded ? "home.plan.show_less" : "home.plan.show_all",{count:rows.length})}</Button> : null}
 </section>;
}
