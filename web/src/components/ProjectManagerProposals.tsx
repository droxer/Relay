"use client";
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getProjectManager } from "../api-client/project-manager";
import type { AppliedManagerProposal } from "../domain-types/project-manager";
import type { RelaySession, RelayTaskListItem } from "../types";
import { HOME_TASKS_QUERY_KEY, ISSUES_PAGE_KEY, SESSIONS_QUERY_KEY, TASKS_QUERY_KEY, THREAD_TASKS_QUERY_KEY } from "../hooks/useRelayData";
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
    const projectThreads = new Set(client.getQueryData<RelaySession[]>(SESSIONS_QUERY_KEY)?.filter(
      session => session.projectId === projectId,
    ).map(session => session.id));
    projectThreads.add(threadId);
    void client.invalidateQueries({
      queryKey: TASKS_QUERY_KEY,
      predicate: ({ queryKey }) => {
        const [scope, filter] = queryKey.slice(TASKS_QUERY_KEY.length);
        if (scope === undefined || scope === projectId || scope === HOME_TASKS_QUERY_KEY.at(-1) || scope === "issues") return true;
        if (typeof filter !== "string") return false;
        if (scope === THREAD_TASKS_QUERY_KEY.at(-1)) return projectThreads.has(filter);
        if (scope !== ISSUES_PAGE_KEY.at(-1)) return false;
        const params = new URLSearchParams(filter);
        const project = params.get("projectId");
        return project === projectId || (!project && params.get("scope") === "issues");
      },
    });
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
