import type { DaemonNodeRunCommand } from "relay-core";

/** Validate ownership before admission, workspace creation, or runtime startup. */
export function assertRunWorkspaceScope(command: DaemonNodeRunCommand, computerId?: string): void {
  const fail = (): never => { throw new Error("Run workspace scope mismatch."); };
  const scope = command.workspaceScope;
  const layout = command.workspaceLayout ?? "node-root";
  const path = command.workspaceSubpath;
  if (!["node-root", "thread", "task", "project"].includes(layout)) fail();
  if (scope && (layout === "thread" || layout === "node-root") && path !== undefined) fail();
  const project = command.state?.project_manager?.projectId ?? command.state?.project_reader?.projectId;
  if (project && (layout !== "project" || (scope && project !== scope.projectId))) fail();
  if (!scope) {
    if (computerId) fail(); // A scope-aware backend may never downgrade a run.
    // Older backends carry no identity. Still refuse a different layout's namespace.
    if (layout === "task" && !/^tasks\/[^/]+(?:\/[^/]+)?$/.test(path ?? "")) fail();
    if (layout === "project" && !/^(projects|links)\/[^/]+$/.test(path ?? "")) fail();
    if (project && path !== `projects/${project}` && path !== `links/${project}`) fail();
    return;
  }
  if (!scope.computerId || !computerId || scope.computerId !== computerId) fail();
  if (scope.projectWorkspaceSubpath !== undefined && !scope.projectId) fail();
  if (scope.legacyLayout !== undefined) {
    // Only the backend may authorize a recorded pre-task-workspace binding.
    if (scope.projectId || scope.legacyLayout !== layout || path !== undefined
      || !["thread", "node-root"].includes(scope.legacyLayout)
      || (layout === "thread" && !scope.taskId) || (scope.automationId && !scope.taskId)) fail();
    return;
  }
  if (scope.projectId) {
    const recorded = scope.projectWorkspaceSubpath;
    if (recorded !== undefined) {
      // A linked folder is created before its Project and has a separate id.
      // Accept only the backend's exact recorded binding, never any other link.
      if (typeof recorded !== "string" || (recorded !== `projects/${scope.projectId}`
        && !/^links\/(?!\.{1,2}$)[^/\\\u0000]+$/.test(recorded))) fail();
      if (layout !== "project" || path !== recorded) fail();
    } else if (layout !== "project" || (path !== `projects/${scope.projectId}` && path !== `links/${scope.projectId}`)) fail();
  } else if (scope.taskId) {
    const owner = scope.automationId ?? scope.taskId;
    if (layout !== "task" || (path !== `tasks/${owner}` && !(scope.automationId && path === `tasks/${owner}/${scope.taskId}`))) fail();
  } else if (layout !== "thread" || scope.automationId) fail();
}

/** "project" and "task" both resolve to a shared durable subpath below the node root. */
export function durableWorkspaceLayout(layout: string | undefined): boolean {
  return layout === "project" || layout === "task";
}

export function requiredWorkspaceSubpath(command: { workspaceSubpath?: string }): string {
  if (!command.workspaceSubpath) {
    throw new Error("Durable workspace command is missing workspaceSubpath.");
  }
  return command.workspaceSubpath;
}
