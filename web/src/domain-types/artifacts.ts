import type { RelayArtifact } from "relay-core";

export interface ArtifactIndexItem extends RelayArtifact {
  sessionId: string;
  sessionTitle?: string;
  taskGoal?: string;
  ownerUserId?: string;
  workspacePath?: string;
  sessionUpdatedAt?: string;
  taskId?: string;
}

export interface ArtifactsResponse {
  artifacts: ArtifactIndexItem[];
}

export interface TaskArtifactsResponse {
  taskId: string;
  artifacts: ArtifactIndexItem[];
}

export type ProducedFileCurrency = "current" | "changed-since" | "deleted" | "unknown";

export type SnapshotSkippedReason =
  | "too-large"
  | "not-snapshotable-type"
  | "sensitive"
  | "unreadable";

/** One file a run of this task created or modified. */
export interface ProducedFile extends ArtifactIndexItem {
  currency: ProducedFileCurrency;
  snapshotSkipped?: SnapshotSkippedReason;
}
