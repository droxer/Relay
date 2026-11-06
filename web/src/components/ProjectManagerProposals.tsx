"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getProjectManager } from "../api-client/project-manager";
import { ManagerProposalCard } from "./ManagerProposalCard";

/** Task proposals belong in the Agent's normal conversation, beside its work. */
export function ProjectManagerProposals({projectId,threadId,readOnly}: {
  projectId:string;threadId:string;readOnly:boolean;
}) {
  const client=useQueryClient();
  const query=useQuery({queryKey:["project-manager",projectId],queryFn:({signal})=>getProjectManager(projectId,signal),refetchInterval:2000});
  const refresh=()=>{void Promise.all([
    client.invalidateQueries({queryKey:["project-manager",projectId]}),client.invalidateQueries({queryKey:["relay"]}),
    client.invalidateQueries({queryKey:["task-record"]}),
  ]);};
  return <>{(query.data?.proposals??[]).filter(proposal=>proposal.threadId===threadId).map(proposal=><ManagerProposalCard
    key={`${proposal.id}:${proposal.revision}`} projectId={projectId} proposal={proposal} disabled={readOnly}
    agents={query.data?.manager?.candidates} teams={query.data?.teams} onChanged={refresh}
  />)}</>;
}
