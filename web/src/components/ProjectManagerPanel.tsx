"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getProjectManager, sendManagerMessage, setProjectManager } from "../api-client/project-manager";
import { answerPermissionRequest, cancelRun, getSession, reconcileExecution, retryExecutionRecovery } from "../api";
import { mergeSessionSnapshotIntoSessions } from "../lib/sessionPollMerge";
import { applySessionEventUnchecked } from "../lib/sessionEvents";
import { projectMessages } from "../lib/projectMessages";
import { openPermissionRequests } from "../lib/permissionRequests";
import { MessageBlock } from "./MessageBlock";
import { PermissionPrompts } from "./composer/PermissionPrompts";
import { ExecutionRecoveryPanel } from "./ExecutionRecoveryPanel";
import { ManagerProposalCard } from "./ManagerProposalCard";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import type { RelaySession } from "../types";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { Dialog, DialogContent, DialogPortal, DialogTitle } from "./ui/dialog";
import { ResizeHandle } from "./ui/ResizeHandle";

export function ProjectManagerPanel({ projectId, projectName, onClose, onOpenThread }: {
  projectId: string; projectName: string; onClose: () => void; onOpenThread: (id: string) => void;
}) {
  const { t } = useTranslation();
  const mobile = useMediaQuery("(max-width: 767px)");
  const client = useQueryClient();
  const key = ["project-manager", projectId];
  const manager = useQuery({ queryKey: key, queryFn: ({signal}) => getProjectManager(projectId, signal), refetchInterval: 2000 });
  const threadId = manager.data?.manager.threadId;
  const session = useQuery({
    queryKey: ["project-manager-thread", threadId], enabled: Boolean(threadId),
    queryFn: ({signal}) => getSession(threadId!, signal), refetchInterval: 1000,
    structuralSharing: (old, next) => mergeSessionSnapshotIntoSessions(old ? [old as RelaySession] : [], next as RelaySession, applySessionEventUnchecked)[0],
  });
  const [text, setText] = useState("");
  const [actionError, setActionError] = useState("");
  const request = useRef<{text: string; key: string} | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const panelElement = useRef<HTMLElement>(null);
  const [panelWidth, setPanelWidth] = useState(448);
  useEffect(() => {
    const panel = panelElement.current;
    const project = panel?.closest<HTMLElement>(".project-workspace-page");
    if (mobile || !panel || !project || typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(() => {
      const width = Math.round(panel.getBoundingClientRect().width);
      project.style.setProperty("--manager-panel-width", `${width}px`);
      setPanelWidth(width);
    });
    resize.observe(panel);
    return () => {resize.disconnect(); project.style.removeProperty("--manager-panel-width");};
  }, [mobile, projectId]);
  async function refresh() {
    await Promise.all([
      client.invalidateQueries({queryKey:key}), client.invalidateQueries({queryKey:["relay"]}),
      client.invalidateQueries({queryKey:["task-record"]}),
      client.invalidateQueries({queryKey:["project-manager-thread", threadId]}),
      client.invalidateQueries({queryKey:["project-manager-overview", projectId]}),
    ]);
  }
  const send = useMutation({ mutationFn: async () => {
    const message = text.trim();
    if (request.current?.text !== message) request.current = {text: message, key: crypto.randomUUID()};
    return sendManagerMessage(projectId, {text:message, idempotencyKey:request.current!.key});
  }, onSuccess: async () => {setText(""); request.current = null; await refresh();} });
  const change = useMutation({mutationFn: (agentId: string) => setProjectManager(projectId, agentId, manager.data!.project.version), onSuccess: refresh});
  // The canonical Thread's goal names the manager room. Actual owner asks
  // arrive as user.message events, so do not render the room name as an ask.
  const messages = projectMessages(session.data, t).filter(message => message.id !== `${threadId}:goal`);
  const execution = session.data?.execution;
  const active = Boolean(execution && execution.phase !== "terminal");
  const reason = manager.data?.manager.reason;
  const readOnly = Boolean(manager.data?.project.archivedAt || manager.data?.project.enabled === false);
  const update = async (action: () => Promise<unknown>) => {
    setActionError("");
    try { await action(); await refresh(); }
    catch (cause) {setActionError(cause instanceof Error ? cause.message : String(cause));}
  };
  const panel = <aside ref={panelElement} className="project-manager-panel" aria-label={`${t("project_manager.title")} ${t("project_manager.role")}`} onKeyDown={event => {if(event.key === "Escape" && !mobile) onClose();}}>
    {!mobile ? <ResizeHandle className="thread-space-resize manager-resize-handle" label={t("project_manager.resize")} width={panelWidth} min={280} max={600} defaultWidth={448} grows="inline-start"
      ceiling={() => Math.min(600, (panelElement.current?.parentElement?.clientWidth ?? 800) * 0.85)}
      clamp={(width, max) => Math.max(280, Math.min(width, max))}
      onResize={width => {if(panelElement.current) panelElement.current.style.width = `${width}px`;}}
      onResizeActive={() => undefined} /> : null}
    <header className="manager-header">
      <div><h2>{t("project_manager.title")}</h2><p>{projectName} · {t("project_manager.role")}{manager.data?.manager.agentName ? ` · ${t("project_manager.via", {name:manager.data.manager.agentName})}` : ""}</p></div>
      <Button variant="ghost" onClick={onClose}>{t("project_manager.back")}</Button>
    </header>
    <div className="manager-content">
      {manager.isPending ? <p role="status">{t("project_manager.loading")}</p> : null}
      {manager.error ? <p role="alert">{manager.error.message} <Button variant="ghost" onClick={() => void manager.refetch()}>{t("project_manager.retry")}</Button></p> : null}
      {manager.data ? <div className="manager-configuration">
        <label htmlFor={`manager-agent-${projectId}`}>{t("project_manager.agent")}</label>
        <select id={`manager-agent-${projectId}`} value={manager.data.manager.agentId ?? ""} disabled={readOnly || change.isPending} onChange={e => {if(e.target.value) change.mutate(e.target.value);}}>
          <option value="">{t("project_manager.choose")}</option>
          {!manager.data.manager.candidates.some(a => a.id === manager.data!.manager.agentId) && manager.data.manager.agentId ? <option value={manager.data.manager.agentId}>{t("project_manager.agent_unavailable")}</option> : null}
          {manager.data.manager.candidates.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}
        </select>
        {!manager.data.manager.candidates.length ? <a href="/agents">{t("project_manager.setup")}</a> : null}
        {reason ? <p role="status">{t(`project_manager.reason_${reason}`, {defaultValue:reason})}</p> : null}
        {reason === "project_manager_update_required" ? <a href="/computers">{t("project_manager.update_computer")}</a> : null}
      </div> : null}
      <div className="manager-transcript" aria-label={t("project_manager.conversation")}>
        {!messages.length ? <p>{t("project_manager.intro")}</p> : null}
        {messages.map(message => <MessageBlock key={message.id} sessionId={threadId!} message={message}
          logicalAgentNames={Object.fromEntries(Object.entries(manager.data?.manager.agentNames ?? Object.fromEntries((manager.data?.manager.candidates ?? []).map(a => [a.id,a.displayName]))).map(([id,name]) => [id,`Relay · ${t("project_manager.via", {name})}`]))} />)}
      </div>
      {session.error ? <p role="alert">{session.error.message}</p> : null}
      {threadId ? <Button variant="ghost" onClick={() => onOpenThread(threadId)}>{t("project_manager.open_thread")}</Button> : null}
      {session.data ? <ExecutionRecoveryPanel session={session.data} onRetry={() => update(() => retryExecutionRecovery(threadId!))} onReportGone={() => update(() => reconcileExecution(threadId!))} /> : null}
      <PermissionPrompts requests={openPermissionRequests(session.data)} agentLabel={() => manager.data?.manager.agentName || "Relay"} onAnswer={(id, answer) => update(() => answerPermissionRequest(threadId!, id, answer))} />
      {manager.data?.proposals.map(proposal => <ManagerProposalCard key={`${proposal.id}:${proposal.revision}`} projectId={projectId} proposal={proposal} disabled={readOnly} agents={manager.data.manager.candidates} teams={manager.data.teams} onChanged={() => void refresh()} />)}
    </div>
    <form className="manager-composer" onSubmit={event => {event.preventDefault(); if(text.trim() && !active && !reason) send.mutate();}}>
      <div className="manager-prompts">{["update", "attention", "next", "plan"].map(prompt => <Button key={prompt} type="button" variant="ghost" size="dense" disabled={readOnly} onClick={() => {
        const now = new Date(); const since = new Date(now); since.setDate(since.getDate() - 7);
        setText(t(`project_manager.prompt_${prompt}`, {since:since.toLocaleDateString(),until:now.toLocaleDateString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})); composer.current?.focus();
      }}>{t(`project_manager.quick_${prompt}`)}</Button>)}</div>
      <label className="sr-only" htmlFor={`manager-text-${projectId}`}>{t("project_manager.ask")}</label>
      <Textarea ref={composer} id={`manager-text-${projectId}`} value={text} maxLength={20000} disabled={readOnly || send.isPending} onChange={e => setText(e.target.value)} placeholder={t("project_manager.ask")} />
      {send.error || change.error || actionError ? <p role="alert">{send.error?.message || change.error?.message || actionError}</p> : null}
      <div className="manager-actions">
        {active ? <Button type="button" variant="outline" onClick={() => void update(() => cancelRun(threadId!))}>{t("project_manager.stop")}</Button> : null}
        <Button type="submit" disabled={!text.trim() || Boolean(reason) || active || send.isPending || !manager.data}>{send.isPending ? t("project_manager.sending") : t("project_manager.send")}</Button>
        <span role="status">{active ? t("project_manager.working") : ""}</span>
      </div>
    </form>
  </aside>;
  return mobile ? <Dialog open onOpenChange={open => {if(!open) onClose();}}>
    <DialogPortal><DialogContent className="project-manager-mobile-shell" initialFocus={false}>
      <DialogTitle className="sr-only">{t("project_manager.role")}</DialogTitle>{panel}
    </DialogContent></DialogPortal>
  </Dialog> : panel;
}
