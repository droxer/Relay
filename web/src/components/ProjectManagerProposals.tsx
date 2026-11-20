"use client";
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getProjectManager } from "../api-client/project-manager";
import { PROJECTS_QUERY_KEY, SESSIONS_QUERY_KEY, TASKS_QUERY_KEY } from "../hooks/useRelayData";
import { ManagerProposalCard } from "./ManagerProposalCard";

/** How often a live run's staged proposals are checked for. */
const LIVE_PROPOSAL_POLL_MS = 2000;

/** Task proposals belong in the Agent's normal conversation, beside its work.
 *  Only a running turn can stage one, and the owner's own apply or dismiss
 *  refreshes the card, so the view polls only while the thread runs and reads
 *  once more when the run ends, catching a proposal staged in its last moments. */
export function ProjectManagerProposals({projectId,threadId,readOnly,running}: {
  projectId:string;threadId:string;readOnly:boolean;running:boolean;
}) {
  const client=useQueryClient();
  const query=useQuery({queryKey:["project-manager",projectId],queryFn:({signal})=>getProjectManager(projectId,signal),
    refetchInterval:running?LIVE_PROPOSAL_POLL_MS:false});
  const wasRunning=useRef(running);
  const {refetch}=query;
  useEffect(()=>{
    if (wasRunning.current && !running) void refetch();
    wasRunning.current=running;
  },[running,refetch]);
  const refresh=()=>{void Promise.all([
    client.invalidateQueries({queryKey:["project-manager",projectId]}),
    // Applying a proposal changes the project and creates tasks; computers
    // and sandboxes are untouched, so they are not refetched.
    client.invalidateQueries({queryKey:PROJECTS_QUERY_KEY,exact:true}),
    client.invalidateQueries({queryKey:TASKS_QUERY_KEY,exact:true}),
    client.invalidateQueries({queryKey:SESSIONS_QUERY_KEY,exact:true}),
    client.invalidateQueries({queryKey:["task-record"]}),
  ]);};
  return <>{(query.data?.proposals??[]).filter(proposal=>proposal.threadId===threadId).map(proposal=><ManagerProposalCard
    key={`${proposal.id}:${proposal.revision}`} projectId={projectId} proposal={proposal} disabled={readOnly}
    agents={query.data?.manager?.candidates} teams={query.data?.teams} onChanged={refresh}
  />)}</>;
}
