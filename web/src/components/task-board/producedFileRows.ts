import type {
  ProducedFile,
  TaskFilesResponse,
  WorkspaceFileEntry,
} from "../../types";

export type ProducedFilesState = "loading" | "failed" | "empty" | "ready";

/** Keep offline indexed results visible instead of calling the task empty. */
export function producedFilesState(query: {
  isLoading: boolean;
  error: unknown;
  data: TaskFilesResponse | undefined;
}): ProducedFilesState {
  if (query.isLoading) return "loading";
  if (query.error || !query.data) return "failed";
  if (
    query.data.produced.length === 0
    && query.data.live.entries.length === 0
  ) {
    return "empty";
  }
  return "ready";
}

/** Live entries no run claimed, so a file appears in only one tier. */
export function secondaryTierEntries(
  produced: ProducedFile[],
  entries: WorkspaceFileEntry[],
): WorkspaceFileEntry[] {
  const claimed = new Set(
    produced
      .map((file) => file.workspaceRelativePath)
      .filter((path): path is string => Boolean(path)),
  );
  return entries.filter((entry) => !claimed.has(entry.path));
}

/** Durability comes from the stored record, never from its extension. */
export function durabilityTone(file: ProducedFile): "stored" | "live-only" {
  return file.snapshotSkipped ? "live-only" : "stored";
}
