"use client";
import { useQuery, useQueryClient, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import {
  getTeamWorkflowChoices, getWorkflow, getWorkflowName, listProjectWorkflowChoices, listWorkflowPreviews, RelayApiError,
  type TeamWorkflowChoicesResponse, type TeamWorkflowLinkUpdate, type TeamWorkflowUpdate,
  type WorkflowChoicesResponse, type WorkflowNameResponse, type WorkflowPreviewsResponse, type WorkflowSaveResponse,
} from "../api";
import type { PrivateResponseCache } from "../api-client/client";
import type { AgentTeam, AgentTeamsResponse, TeamWorkflowPreview, Workflow, WorkflowPreview } from "../types";
import { predefinedStyle, teamWorkflowPreviews } from "../lib/workflowSelection";
import { teamRecordKey, TEAM_RECORD_QUERY_KEY, TEAMS_QUERY_KEY } from "./useTeams";

export const WORKFLOWS_QUERY_KEY = "workflows";
export const TEAM_WORKFLOW_CHOICES_KEY = [WORKFLOWS_QUERY_KEY, "team-choices"] as const;
const WORKFLOW_STALE_MS = 15_000;
const WORKFLOW_REFRESH_MS = 30_000;
const choiceValidators = new WeakMap<Query, PrivateResponseCache<WorkflowChoicesResponse>>();
const teamChoiceValidators = new WeakMap<Query, PrivateResponseCache<TeamWorkflowChoicesResponse>>();
const previewValidators = new WeakMap<Query, PrivateResponseCache<WorkflowPreviewsResponse>>();
const recordValidators = new WeakMap<Query, PrivateResponseCache<{ workflow: Workflow }>>();
const nameValidators = new WeakMap<Query, PrivateResponseCache<WorkflowNameResponse>>();

function responseCache<T>(client: QueryClient, queryKey: QueryKey, validators: WeakMap<Query, PrivateResponseCache<T>>) {
  const entry = client.getQueryCache().find({ queryKey, exact: true });
  const cache = (entry && validators.get(entry)) || {};
  if (entry) validators.set(entry, cache);
  return cache;
}

export function useProjectWorkflows(projectId: string) {
  return useQuery({
    queryKey: [WORKFLOWS_QUERY_KEY, "preview", projectId],
    queryFn: ({ signal, client, queryKey }) => listWorkflowPreviews(projectId, signal, responseCache(client, queryKey, previewValidators)),
    staleTime: WORKFLOW_STALE_MS, refetchInterval: WORKFLOW_REFRESH_MS,
  });
}

export function useProjectWorkflowChoices(projectId?: string, enabled = true) {
  return useQuery({
    queryKey: [WORKFLOWS_QUERY_KEY, "choices", projectId ?? "all"],
    queryFn: ({ signal, client, queryKey }) => listProjectWorkflowChoices(projectId, signal, responseCache(client, queryKey, choiceValidators)),
    enabled, staleTime: WORKFLOW_STALE_MS,
  });
}

export function useTeamWorkflowChoices(team: AgentTeam, enabled: boolean) {
  return useQuery({
    queryKey: [...TEAM_WORKFLOW_CHOICES_KEY, team.ownerUserId, team.id, team.computerId, [...team.memberAgentIds].sort()],
    queryFn: ({ signal, client, queryKey }) => getTeamWorkflowChoices(team, signal, responseCache(client, queryKey, teamChoiceValidators)),
    enabled, staleTime: WORKFLOW_STALE_MS,
  });
}

export function workflowRecordIsOlder(record: Workflow, preview: WorkflowPreview): boolean {
  if (record.version !== undefined && preview.version !== undefined) return record.version < preview.version;
  return record.updatedAt < preview.updatedAt;
}

export function useWorkflowRecord(preview?: WorkflowPreview | null) {
  const workflowId = preview?.id;
  return useQuery({
    queryKey: [WORKFLOWS_QUERY_KEY, "record", workflowId],
    queryFn: ({ signal, client, queryKey }) => getWorkflow(workflowId!, signal, responseCache(client, queryKey, recordValidators)),
    enabled: Boolean(workflowId),
    staleTime: (query) => preview && query.state.data && workflowRecordIsOlder(query.state.data.workflow, preview) ? 0 : WORKFLOW_STALE_MS,
  });
}

export function useWorkflowName(workflowId?: string | null, projectId?: string | null) {
  const client = useQueryClient();
  return useQuery({
    queryKey: [WORKFLOWS_QUERY_KEY, "name", workflowId],
    enabled: Boolean(workflowId) && !predefinedStyle(workflowId),
    staleTime: WORKFLOW_STALE_MS,
    refetchInterval: WORKFLOW_REFRESH_MS,
    queryFn: async ({ signal, queryKey }) => {
      if (!workflowId) return null;
      for (const scope of projectId ? [projectId, "all"] : ["all"]) {
        for (const view of ["preview", "choices"]) {
          const key = [WORKFLOWS_QUERY_KEY, view, scope];
          const catalog = client.getQueryState<{ workflows: Pick<Workflow, "id" | "name">[] }>(key);
          if (!catalog?.data || catalog.isInvalidated || Date.now() - catalog.dataUpdatedAt >= WORKFLOW_STALE_MS) continue;
          const cached = catalog.data.workflows.find(workflow => workflow.id === workflowId);
          if (cached) return cached.name;
        }
      }
      try {
        return (await getWorkflowName(workflowId, signal, responseCache(client, queryKey, nameValidators))).workflow.name;
      } catch (error) {
        if (error instanceof RelayApiError && (error.status === 404 || error.status === 403)) return null;
        throw error;
      }
    },
  });
}

function workflowPreviewSteps(workflow: Workflow) {
  return workflow.workflowSteps.map(({ id, name, agentId, requiresApproval }) => ({ id, name, agentId, requiresApproval }));
}

function workflowAgentIds(workflow: Workflow) {
  return [...new Set(workflow.workflowSteps.map(step => step.agentId))];
}

function updateTeamWorkflow(team: AgentTeam, workflow: Workflow, detail: boolean): AgentTeam | undefined {
  const option = team.workflowOptions?.find(item => item.id === workflow.id && item.kind === "steps");
  const preview = team.workflowPreviews?.find(item => item.id === workflow.id);
  const version = workflow.version;
  if (version === undefined || option?.version === undefined || (detail && preview?.version === undefined)) return undefined;
  if (option.version >= version || (preview?.version ?? -1) >= version) return team;
  // A cached rename can affect the server's catalog order.
  if (option.name !== workflow.name || (preview && preview.name !== workflow.name)) return undefined;
  return {
    ...team,
    ...(team.id === workflow.id && team.workflowStepCount !== undefined ? { workflowStepCount: workflow.workflowSteps.length } : {}),
    workflowOptions: team.workflowOptions?.map(item => item === option ? {
      ...item, version, updatedAt: workflow.updatedAt, enabled: workflow.enabled,
      stepCount: workflow.workflowSteps.length, stepAgentIds: workflowAgentIds(workflow),
    } : item),
    ...(detail ? { workflowPreviews: team.workflowPreviews?.map(item => item === preview ? {
      ...item, version, updatedAt: workflow.updatedAt, enabled: workflow.enabled, workflowSteps: workflowPreviewSteps(workflow),
    } : item) } : {}),
  };
}

async function updateWorkflowQuery<T>(client: QueryClient, key: QueryKey, apply: (data: T) => T | undefined) {
  const state = client.getQueryState<T>(key);
  if (!state) return;
  const current = state.data;
  if (current && !state.isInvalidated) {
    const next = apply(current);
    if (next === current) return;
    if (next) {
      await client.cancelQueries({ queryKey: key, exact: true });
      const latest = client.getQueryState<T>(key);
      const updated = latest?.data && !latest.isInvalidated ? apply(latest.data) : undefined;
      if (updated && latest) {
        if (updated !== latest.data) client.setQueryData(key, updated, { updatedAt: latest.dataUpdatedAt });
        return;
      }
    }
  }
  await client.invalidateQueries({ queryKey: key, exact: true });
}

function applyWorkflowLink(team: AgentTeam, update: TeamWorkflowLinkUpdate, detail: boolean): AgentTeam | undefined {
  if (!team.workflowOptions || (detail && !team.workflowPreviews)) return undefined;
  const options = new Map(team.workflowOptions.filter(item => item.kind === "steps").map(item => [item.id, item]));
  const previews = new Map(team.workflowPreviews?.map(item => [item.id, item]));
  if (update.workflow) {
    const { id, name, projectId, enabled, version, updatedAt, workflowSteps } = update.workflow;
    if (id !== update.workflowId || update.workflow.teamId !== team.id || version === undefined
      || (options.get(id)?.version ?? -1) > version || (previews.get(id)?.version ?? -1) > version) return undefined;
    previews.set(id, update.workflow);
    options.set(id, { id, name, projectId, enabled, version, updatedAt, kind: "steps",
      stepCount: workflowSteps.length, stepAgentIds: [...new Set(workflowSteps.map(step => step.agentId))] });
  }
  const workflowOptions = team.workflowOptions.filter(item => item.kind === "predefined");
  const workflowPreviews: TeamWorkflowPreview[] = [];
  for (const { id, version } of update.workflowOrder) {
    const option = options.get(id);
    if (!option || option.version !== version) return undefined;
    workflowOptions.push(option);
    if (detail) {
      const preview = previews.get(id);
      if (!preview || preview.version !== version) return undefined;
      workflowPreviews.push(preview);
    }
  }
  return { ...team, workflowOptions, ...(detail ? { workflowPreviews } : {}) };
}

export async function syncTeamWorkflowUpdate(
  client: QueryClient, userId: string | undefined, teamId: string, update: TeamWorkflowUpdate,
) {
  function apply(team: AgentTeam, detail: boolean): AgentTeam | undefined {
    if (team.id !== teamId || update.teamId !== teamId || update.version !== update.baseVersion + 1 || team.version === undefined) return undefined;
    if (team.version >= update.version) return team;
    if (team.version !== update.baseVersion) return undefined;
    const updated = { ...team, version: update.version, updatedAt: update.updatedAt };
    if ("workflowOrder" in update) return applyWorkflowLink(updated, update, detail);
    updated.defaultWorkflowId = update.defaultWorkflowId;
    if (!update.legacyWorkflow) {
      delete updated.projectId;
      delete updated.workflowSteps;
      delete updated.workflowStepCount;
    }
    if (update.projectDefault) {
      const { projectId, workflowId } = update.projectDefault;
      const defaults = { ...team.projectWorkflowDefaults };
      if (workflowId === null) delete defaults[projectId];
      else defaults[projectId] = workflowId;
      updated.projectWorkflowDefaults = defaults;
    }
    return updated;
  }

  // The roster can prompt TeamsPage to reload an older record.
  await updateWorkflowQuery<{ team: AgentTeam }>(client, teamRecordKey(userId, teamId), data => {
    const updated = apply(data.team, true);
    return updated === data.team ? data : updated && { ...data, team: updated };
  });
  await updateWorkflowQuery<AgentTeamsResponse>(client, [TEAMS_QUERY_KEY, userId], data => {
    const team = data.teams.find(item => item.id === teamId);
    if (!team || ("workflowOrder" in update && data.view !== "summary")) return undefined;
    const updated = apply(team, false);
    return updated === team ? data : updated && { ...data, teams: data.teams.map(item => item === team ? updated : item) };
  });
}

async function refreshTeamWorkflows(client: QueryClient, result: WorkflowSaveResponse | undefined, projectEdit: boolean) {
  const workflow = result?.workflow;
  if (!workflow?.ownerUserId || (!workflow.ownerTeamId && !projectEdit)) {
    await Promise.all([
      client.invalidateQueries({ queryKey: [TEAMS_QUERY_KEY] }),
      client.invalidateQueries({ queryKey: [TEAM_RECORD_QUERY_KEY] }),
    ]);
    return;
  }
  const rosterKey = [TEAMS_QUERY_KEY, workflow.ownerUserId];
  const recordKeys = workflow.ownerTeamId
    ? [teamRecordKey(workflow.ownerUserId, workflow.ownerTeamId)]
    : client.getQueriesData<{ team: AgentTeam }>({ queryKey: [TEAM_RECORD_QUERY_KEY, workflow.ownerUserId] }).map(([key]) => key);
  if (workflow.ownerTeamId && !result?.teamLinkUnchanged) {
    await Promise.all([
      client.invalidateQueries({ queryKey: rosterKey, exact: true }),
      client.invalidateQueries({ queryKey: recordKeys[0], exact: true }),
    ]);
    return;
  }
  const hasWorkflow = (team: AgentTeam) => workflow.ownerTeamId
    ? team.id === workflow.ownerTeamId
    : team.id === workflow.id || team.workflowOptions?.some(item => item.id === workflow.id)
      || teamWorkflowPreviews(team).some(item => item.id === workflow.id);
  // TeamsPage compares the selected record with the roster. Update the record
  // first so it already has the new preview when the roster notifies observers.
  await Promise.all(recordKeys.map(key => updateWorkflowQuery<{ team: AgentTeam }>(client, key, (data) => {
    if (!hasWorkflow(data.team)) return data;
    const summary = client.getQueryData<AgentTeamsResponse>(rosterKey)?.teams.find(item => item.id === data.team.id);
    const rosterVersion = summary?.workflowOptions?.find(item => item.id === workflow.id)?.version ?? -1;
    const previewVersion = data.team.workflowPreviews?.find(item => item.id === workflow.id)?.version ?? -1;
    if (rosterVersion > Math.max(previewVersion, workflow.version ?? -1)) return undefined;
    const updated = updateTeamWorkflow(data.team, workflow, true);
    return updated === data.team ? data : updated && { ...data, team: updated };
  })));
  await updateWorkflowQuery<AgentTeamsResponse>(client, rosterKey, (data) => {
    const teams = [];
    for (const team of data.teams) {
      const updated = !hasWorkflow(team) ? team : data.view === "summary" ? updateTeamWorkflow(team, workflow, false) : undefined;
      if (!updated) return undefined;
      teams.push(updated);
    }
    return teams.some((team, index) => team !== data.teams[index]) ? { ...data, teams } : data;
  });
}

export function useInvalidateWorkflows() {
  const client = useQueryClient();
  return async (result?: WorkflowSaveResponse, original?: Workflow | null) => {
    const workflow = result?.workflow;
    const projectEdit = workflow?.projectId && workflow.projectId === original?.projectId && workflow.version !== undefined
      ? workflow : undefined;
    const choicesChanged = !projectEdit || !original || projectEdit.name !== original.name || projectEdit.enabled !== original.enabled
      || JSON.stringify(workflowAgentIds(projectEdit)) !== JSON.stringify(workflowAgentIds(original));
    if (workflow) {
      const recordKey = [WORKFLOWS_QUERY_KEY, "record", workflow.id];
      const nameKey = [WORKFLOWS_QUERY_KEY, "name", workflow.id];
      await Promise.all([
        client.cancelQueries({ queryKey: recordKey, exact: true }),
        client.cancelQueries({ queryKey: nameKey, exact: true }),
      ]);
      const latest = client.getQueryData<{ workflow: Workflow }>(recordKey)?.workflow;
      if (!latest || !workflowRecordIsOlder(workflow, latest)) {
        client.setQueryData(recordKey, { workflow });
        client.setQueryData(nameKey, workflow.name);
      }
    }
    await Promise.all([
      client.invalidateQueries({
        queryKey: [WORKFLOWS_QUERY_KEY],
        predicate: ({ queryKey: [, view, id] }) => {
          if (view === "record" || (view === "name" && id === workflow?.id)) return false;
          if (view === "team-choices") return !workflow || (id === workflow.ownerUserId && choicesChanged && Boolean(workflow.projectId));
          if (!original || !workflow) return true;
          // An edit keeps the Workflow's owner and Project scope.
          if (view === "preview") return !projectEdit && id === workflow.projectId;
          if (view === "choices") return choicesChanged && Boolean(workflow.projectId) && (id === "all" || id === workflow.projectId);
          return false;
        },
      }),
      projectEdit && updateWorkflowQuery<WorkflowPreviewsResponse>(client, [WORKFLOWS_QUERY_KEY, "preview", projectEdit.projectId], data => {
        const preview = data.workflows.find(item => item.id === projectEdit.id);
        if (data.view !== "preview" || preview?.version === undefined) return undefined;
        if (!workflowRecordIsOlder(projectEdit, preview) && projectEdit.version !== preview.version) {
          if (preview.name !== projectEdit.name) return undefined;
          return { ...data, workflows: data.workflows.map(item => item === preview ? {
            ...item, version: projectEdit.version, updatedAt: projectEdit.updatedAt,
            enabled: projectEdit.enabled, workflowSteps: workflowPreviewSteps(projectEdit),
          } : item) };
        }
        return data;
      }),
      refreshTeamWorkflows(client, result, Boolean(projectEdit)),
    ]);
  };
}
