import type { ProjectRecord, RelayTask } from "../types";

export type ManagerFields = {
  title?: string; description?: string; priority?: string; dueDate?: string | null;
  tags?: string[]; assignedAgentId?: string | null; assignedTeamId?: string | null;
};
export interface ManagerOperation {
  id: string; kind: "create" | "update" | "prerequisites"; key?: string; taskId?: string;
  title?: string; fields: ManagerFields; before?: ManagerFields; after: string[]; afterTaskIds: string[];
}
export interface ManagerProposal {
  id: string; projectId: string; threadId: string; agentId: string; runId: string;
  state: "pending" | "applied" | "dismissed" | "superseded" | "expired";
  revision: number; createdAt: string; operations: ManagerOperation[];
}
export interface ProjectManagerResponse {
  project: ProjectRecord;
  manager: { agentId: string | null; agentName: string | null; agentNames?: Record<string,string>; threadId: string | null;
    toolsAvailable: boolean; reason: string | null; candidates: Array<{id: string; displayName: string}> };
  proposals: ManagerProposal[];
  teams?: Array<{id: string; displayName: string}>;
}
export interface ApplyManagerInput {
  idempotencyKey: string; expectedRevision: number; operationIds: string[]; fields: Record<string, ManagerFields>;
}
export interface AppliedManagerProposal { proposal: ManagerProposal; tasks: RelayTask[] }
