import type { GitHubImportResponse, GitHubIssuePreview } from "../types.ts";

/* The GitHub import drawer's rules, kept out of the component so they test
   without a DOM. The server (relay/tasks/github_import.py) is the authority
   on what was imported; these only shape what the drawer offers. */

/** Codes the backend answers that have their own copy; anything else reads
 *  as the generic failure. */
export const GITHUB_ERROR_CODES = [
  "github_repository_required",
  "github_public_repositories_only",
  "github_repository_invalid",
  "github_repository_moved",
  "github_token_invalid",
  "github_token_rejected",
  "github_not_found",
  "github_issues_disabled",
  "github_forbidden",
  "github_rate_limited",
  "github_timeout",
  "github_unreachable",
  "github_unavailable",
  "github_import_too_large",
  "github_reconnect_required",
] as const;

export const MAX_IMPORT_ISSUES = 50;

/** The i18n key for a failure code from either route. */
export function githubErrorKey(code: string | undefined): string {
  return code && (GITHUB_ERROR_CODES as readonly string[]).includes(code)
    ? `github_import.errors.${code}`
    : "github_import.errors.generic";
}

/** A later page appended to what is listed, without repeating an issue. */
export function mergeIssuePages(current: readonly GitHubIssuePreview[], next: readonly GitHubIssuePreview[]): GitHubIssuePreview[] {
  const seen = new Set(current.map((issue) => issue.number));
  return [...current, ...next.filter((issue) => !seen.has(issue.number))];
}

/** Issues the destination does not hold yet — the only ones a person may pick. */
export function importableIssues(issues: readonly GitHubIssuePreview[]): GitHubIssuePreview[] {
  return issues.filter((issue) => !issue.importedTaskId);
}

/** Whether the first importable batch is selected, matching the import cap. */
export function allImportableSelected(selected: ReadonlySet<number>, issues: readonly GitHubIssuePreview[]): boolean {
  const importable = importableIssues(issues).slice(0, MAX_IMPORT_ISSUES);
  return importable.length > 0 && importable.every((issue) => selected.has(issue.number));
}

/** Select the first importable batch, or clear the selection if it is on. */
export function toggleAllImportable(selected: ReadonlySet<number>, issues: readonly GitHubIssuePreview[]): Set<number> {
  const importable = importableIssues(issues).map((issue) => issue.number);
  return allImportableSelected(selected, issues) ? new Set() : new Set(importable.slice(0, MAX_IMPORT_ISSUES));
}

/** Mark the issues an import just created, so the list shows them imported. */
export function markImported(issues: readonly GitHubIssuePreview[], result: GitHubImportResponse): GitHubIssuePreview[] {
  const taskByNumber = new Map<number, string>();
  for (const task of result.created) {
    const number = task.externalSource?.number;
    if (number) taskByNumber.set(number, task.id);
  }
  for (const skip of result.skipped) {
    if (skip.taskId) taskByNumber.set(skip.number, skip.taskId);
  }
  return issues.map((issue) =>
    taskByNumber.has(issue.number) ? { ...issue, importedTaskId: taskByNumber.get(issue.number) ?? null } : issue,
  );
}

/** Only a github.com link is ever rendered as one. */
export function safeGitHubUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}
