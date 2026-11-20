"use client";
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getProjectManager } from "../api-client/project-manager";
import type { AppliedManagerProposal } from "../domain-types/project-manager";
import type { RelayTaskListItem } from "../types";
import { HOME_TASKS_QUERY_KEY, TASKS_QUERY_KEY } from "../hooks/useRelayData";
import { TASK_RECORD_QUERY_KEY } from "../hooks/useTaskRecord";
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
  const refresh = (applied?: AppliedManagerProposal) => {
    void client.invalidateQueries({ queryKey: ["project-manager", projectId], exact: true });
    if (!applied) return;
    const changed = new Set(applied.tasks.map(task => task.id));
    for (const queryKey of [TASKS_QUERY_KEY, HOME_TASKS_QUERY_KEY, [...TASKS_QUERY_KEY, projectId]]) {
      void client.invalidateQueries({ queryKey, exact: true });
    }
    // A prerequisite change can also affect another Task's derived dependents.
    void client.invalidateQueries({ queryKey: [TASK_RECORD_QUERY_KEY], predicate: ({ queryKey, state }) =>
      changed.has(String(queryKey[1])) || (state.data as RelayTaskListItem | undefined)?.projectId === projectId });
    if (applied.proposal?.operations.some(operation => "tags" in operation.fields)) {
      void client.invalidateQueries({ queryKey: ["account", "tags"] });
    }
  };
  return <>{(query.data?.proposals??[]).filter(proposal=>proposal.threadId===threadId).map(proposal=><ManagerProposalCard
    key={`${proposal.id}:${proposal.revision}`} projectId={projectId} proposal={proposal} disabled={readOnly}
    agents={query.data?.manager?.candidates} teams={query.data?.teams} onChanged={refresh}
  />)}</>;
}
