import type {
  EmployeeAgent,
  ProjectMember,
  ProjectRecord,
  WorkspaceBriefResponse,
} from "../types.js";

export type ProjectPageTab = "tasks" | "profile" | "workspace";
export type ProjectCollectionStatus = "loading" | "error" | "ready";
export type ProjectOverviewState = "hidden" | "loading" | "error" | "not-found" | "ready";

export const PROJECT_PAGE_TABS: readonly ProjectPageTab[] = ["tasks", "profile", "workspace"];

/** Backend roster cap — the add-member affordance hides at the limit. */
export const MAX_PROJECT_MEMBERS = 32;

/* Member eligibility mirrors the backend's project_member_computer_mismatch
   rule exactly (backend/relay/services/project_catalog.py): an agent can join
   a project's roster only when one of its active placements points at the
   project's stable computer id, or — for legacy placements that predate
   computer ids — at the runtime node currently hosting that computer.
   Filtering on runtime node alone (as the thread composer does) offers
   agents the backend then rejects, so the picker cannot reuse it. */
export function agentsEligibleForProject(
  agents: readonly EmployeeAgent[],
  computerId: string,
  runtimeNodeId: string,
): EmployeeAgent[] {
  return agents.filter((agent) =>
    !agent.deletedAt
    && agent.enabled
    && agent.placements.some((placement) =>
      placement.desiredState === "active"
      && (
        placement.computerId === computerId
        || (
          !placement.computerId
          && (placement.runtimeNodeId || placement.daemonNodeId) === runtimeNodeId
        )
      )));
}

export function parseProjectPageTab(value: string | null): ProjectPageTab {
  return PROJECT_PAGE_TABS.includes(value as ProjectPageTab)
    ? value as ProjectPageTab
    : "tasks";
}

export function orderedProjectMembers(project: ProjectRecord): ProjectMember[] {
  return [
    ...project.members.filter((member) => member.agentId === project.leadAgentId),
    ...project.members.filter((member) => member.agentId !== project.leadAgentId),
  ];
}

export function projectMemberState(member: ProjectMember, agent?: EmployeeAgent) {
  const available = Boolean(agent && !agent.deletedAt);
  return {
    available,
    enabled: member.enabled && Boolean(agent?.enabled) && available,
    availability: available ? agent?.availability ?? "offline" : "offline",
  } as const;
}

/**
 * Whether a project is closed for work.
 *
 * An archived or disabled project is a read-only room: its conversations and
 * files stay readable, but nothing new may run in it. Every surface that can
 * act on something belonging to a project asks HERE — the board used to
 * decide it inline, which left the rule enforced in one component and
 * bypassed by every other route to the same task.
 */
export function projectReadOnly(project: ProjectRecord | null | undefined): boolean {
  if (!project) return false;
  return Boolean(project.archivedAt) || !project.enabled;
}

export function projectPageActions(project: ProjectRecord) {
  return {
    settings: true,
    newThread: !projectReadOnly(project),
  } as const;
}

export function resolveProjectOverviewState({
  showProjectOverview,
  project,
  collectionStatus,
}: {
  showProjectOverview: boolean;
  project: ProjectRecord | null;
  collectionStatus: ProjectCollectionStatus;
}): ProjectOverviewState {
  if (!showProjectOverview) return "hidden";
  if (project) return "ready";
  if (collectionStatus === "loading") return "loading";
  if (collectionStatus === "error") return "error";
  return "not-found";
}

export function showThreadChrome(showProjectOverview: boolean): boolean {
  return !showProjectOverview;
}

export function projectActivitiesState({
  isLoading,
  hasData,
  hasError,
}: {
  isLoading: boolean;
  hasData: boolean;
  hasError: boolean;
}): "loading" | "error" | "ready" {
  if (isLoading && !hasData) return "loading";
  if (hasError || !hasData) return "error";
  return "ready";
}

export function scopeProjectActivities(
  brief: WorkspaceBriefResponse,
  projectId: string,
): WorkspaceBriefResponse {
  const sessions = brief.sessions.filter((session) => session.projectId === projectId);
  const sessionIds = new Set(sessions.map((session) => session.id));

  return {
    ...brief,
    activeRuns: brief.activeRuns.filter((run) => sessionIds.has(run.sessionId)),
    sessions,
    tasks: brief.tasks.filter((task) => task.projectId === projectId),
  };
}

/** Whether a polled collection query is loading, failed, or settled.
 *
 *  Kept off the call site because the flags are subtle: `isPending` only
 *  covers a query with no data at all, so a query holding cached rows that is
 *  mid-flight on its first real fetch reads as settled unless the
 *  fetchedAfterMount check catches it. A poll refetch of already-settled data
 *  is deliberately NOT loading — the rail keeps its rows rather than blanking
 *  to a spinner every interval.
 *
 *  This is only trustworthy while nothing writes into the query cache by hand:
 *  setQueryData stamps dataUpdatedAt, which makes isFetchedAfterMount report
 *  true for a request that has not come back. See the logged-out reset in
 *  useRelayData, which must clear through resetQueries for that reason. */
export function queryCollectionStatus(
  { isError, isPending, isFetchedAfterMount, fetchStatus }: {
    isError: boolean;
    isPending: boolean;
    isFetchedAfterMount: boolean;
    fetchStatus: "fetching" | "paused" | "idle";
  },
): ProjectCollectionStatus {
  if (isError) return "error";
  if (isPending || (!isFetchedAfterMount && fetchStatus === "fetching")) return "loading";
  return "ready";
}
