import type { DaemonNodeCommand, DaemonNodeEvent } from "relay-core";
import { ProjectLinkError, type ProjectLinkRegistry } from "./project-links.js";
import { type ThreadWorkspaceManager } from "./thread-workspace.js";
import { durableWorkspaceLayout, requiredWorkspaceSubpath } from "./run-workspace.js";
import { workspaceCommandEvent } from "./workspace-read.js";

export type WorkspaceCommand = Extract<DaemonNodeCommand, { type: `workspace.${string}` }>;

/** Produce a workspace reply independently of its network delivery. */
export function workspaceReply(
  command: WorkspaceCommand,
  workspacePath: string,
  threadWorkspaces: ThreadWorkspaceManager,
  projectLinks: ProjectLinkRegistry,
): DaemonNodeEvent {
  if (command.type === "workspace.delete") {
    if (command.workspaceLayout !== "project" || command.path !== "") {
      throw new Error("Only a complete project workspace can be deleted.");
    }
    threadWorkspaces.deleteProject(command.sessionId, command.workspaceSubpath);
    return { type: "workspace.deleted", commandId: command.id,
      ...(command.leaseId ? { leaseId: command.leaseId } : {}), path: "" };
  }
  if (command.type === "workspace.link") {
    try {
      const hostPath = command.dryRun ? projectLinks.validate(command.hostPath)
        : projectLinks.link(command.workspaceSubpath, command.hostPath);
      return { type: "workspace.linked", commandId: command.id,
        ...(command.leaseId ? { leaseId: command.leaseId } : {}), path: "", hostPath };
    } catch (error) {
      return { type: "workspace.error", commandId: command.id,
        ...(command.leaseId ? { leaseId: command.leaseId } : {}), path: "",
        code: error instanceof ProjectLinkError ? error.code : "io-error",
        message: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    if (command.workspaceLayout === "thread" && !command.sessionId) {
      throw new Error("Thread workspace command is missing sessionId.");
    }
    const path = command.workspaceLayout === "thread"
      ? threadWorkspaces.resolve(command.sessionId!).hostPath
      : durableWorkspaceLayout(command.workspaceLayout) && command.sessionId
        ? threadWorkspaces.resolveSubpath(command.sessionId, requiredWorkspaceSubpath(command)).hostPath
        : workspacePath;
    return workspaceCommandEvent(path, command);
  } catch (error) {
    return { type: "workspace.error", commandId: command.id,
      ...(command.leaseId ? { leaseId: command.leaseId } : {}), path: command.path,
      code: "invalid-path", message: error instanceof Error ? error.message : String(error) };
  }
}
