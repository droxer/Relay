"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getProjectManager, openManagerConversation } from "../api-client/project-manager";
import { Button } from "./ui/button";
import { TonePill } from "./StatusPill";
import { AgentStateBadge } from "./AgentStateBadge";

/** An ordinary Agent holding a Project role. Chat opens the normal Thread. */
export function ProjectManagerAgentCard({ projectId, onOpenThread, onManageRole }: {
  projectId: string; onOpenThread: (threadId: string) => void; onManageRole: () => void;
}) {
  const {t} = useTranslation();
  const client = useQueryClient();
  const query = useQuery({queryKey:["project-manager",projectId],queryFn:({signal})=>getProjectManager(projectId,signal)});
  const manager = query.data?.manager;
  const open = useMutation({mutationFn:()=>openManagerConversation(projectId),onSuccess:async ({threadId})=>{
    await client.invalidateQueries({queryKey:["relay","projects"]});
    await Promise.all([client.invalidateQueries({queryKey:["relay","sessions"]}),client.invalidateQueries({queryKey:["project-manager",projectId]})]);
    onOpenThread(threadId);
  }});
  return <section className="project-manager-agent" aria-label={t("project_manager.role")}>
    {manager?.agentId ? <>
      <AgentStateBadge agent={undefined} name={manager.agentName ?? t("project_manager.agent_unavailable")} ready={!manager.reason} />
      <div className="project-manager-agent-identity"><a href={`/agents/${encodeURIComponent(manager.agentId)}`}>{manager.agentName || t("project_manager.agent_unavailable")}</a>
        <TonePill tone="neutral" label={t("project.roles.project_manager")} />
        <p>{t("project_manager.agent_description")}</p>
      </div>
      <Button onClick={()=>open.mutate()} disabled={open.isPending}>{t("project_manager.chat")}</Button>
    </> : <><p>{query.isPending ? t("project_manager.loading") : t("project_manager.unassigned_role")}</p><Button variant="outline" onClick={onManageRole}>{t("project_manager.assign_role")}</Button></>}
    {manager?.reason ? <p role="status">{t(`project_manager.reason_${manager.reason}`,{defaultValue:manager.reason})}</p> : null}
    {query.error || open.error ? <p role="alert">{query.error?.message || open.error?.message}</p> : null}
  </section>;
}
