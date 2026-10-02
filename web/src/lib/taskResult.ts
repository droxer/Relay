import type { RelaySession, RelayTaskListItem, TaskStatus } from "../types.js";

/**
 * What a task's board record says about its run.
 *
 * The card used to print the word "Linked" — true of any task a session was
 * ever opened for, and silent about whether that run finished, failed, or
 * produced anything. This is the replacement, kept pure so the card and the
 * list row cannot drift into two different readings of the same task.
 */
type TaskResultLine = {
  status: TaskStatus;
  /**
   * Files the latest run produced. The board reads the last linked session
   * rather than a rollup across every session: a retried task's card answers
   * "what did the last run make", which is a different and more useful
   * question than the drawer's "every distinct file this task produced".
   */
  fileCount: number;
  hasFiles: boolean;
};

export function taskResultLine(
  task: RelayTaskListItem,
  session: RelaySession | undefined,
): TaskResultLine | null {
  if (!session) return null;
  const fileCount = session.workspaceArtifactCount ?? 0;
  return { status: task.status, fileCount, hasFiles: fileCount > 0 };
}
