"use client";

import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { importGitHubIssues, previewGitHubIssues, RelayApiError } from "../../api";
import type { GitHubIssuePreview, GitHubIssueState, GitHubIssuesResponse, ProjectRecord } from "../../types";
import { TASKS_QUERY_KEY } from "../../hooks/useRelayData";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Drawer } from "@/components/ui/Drawer";
import { GitHubConnectionPanel } from "../settings/GitHubConnectionPanel";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  allImportableSelected,
  githubErrorKey,
  importableIssues,
  markImported,
  MAX_IMPORT_ISSUES,
  mergeIssuePages,
  safeGitHubUrl,
  toggleAllImportable,
} from "../../lib/githubImport";

const STATES: GitHubIssueState[] = ["open", "closed", "all"];
const NO_PROJECT = "__intake__";

interface GitHubImportDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The board's own project: the destination is fixed to it. */
  lockedProject?: ProjectRecord | null;
  /** Otherwise, the projects a person may import into (none = intake). */
  projects?: ProjectRecord[];
  /** The project picked when the drawer opens, e.g. the list's filter. */
  initialProjectId?: string;
  /** Opens an issue's existing task. */
  onOpenTask?: (taskId: string) => void;
}

interface Listing {
  key: string;
  response: GitHubIssuesResponse;
  issues: GitHubIssuePreview[];
}

function errorCode(error: unknown): string | undefined {
  return error instanceof RelayApiError ? error.code : undefined;
}

/**
 * Brings a GitHub repository's issues in as backlog tasks: name the
 * repository, load a page of issues, tick the ones to bring in. Issues the
 * destination already holds are shown but cannot be picked again. Only public
 * repositories are supported; requests never use GitHub credentials.
 */
export function GitHubImportDrawer({ open, onClose, lockedProject, projects = [], initialProjectId, onOpenTask }: GitHubImportDrawerProps) {
  const { t } = useTranslation();
  const { announce } = useDialogs();
  const queryClient = useQueryClient();
  const stateLabelId = useId();
  const projectLabelId = useId();
  const [repository, setRepository] = useState("");
  const [state, setState] = useState<GitHubIssueState>("open");
  const [labels, setLabels] = useState("");
  const [projectId, setProjectId] = useState<string | undefined>(lockedProject?.id ?? initialProjectId);
  const [listing, setListing] = useState<Listing | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<"loading" | "importing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const destinationId = lockedProject?.id ?? projectId;
  const openProjects = projects.filter((project) => project.enabled && !project.archivedAt);
  const chosenProject = lockedProject ?? openProjects.find((project) => project.id === projectId);
  const query = { repository: repository.trim(), projectId: destinationId, state, labels: labels.trim() };
  const queryKey = JSON.stringify(query);

  async function load(page: number) {
    setBusy("loading");
    setError(null);
    try {
      const response = await previewGitHubIssues({ ...query, page });
      setListing((current) => ({
        key: queryKey,
        response,
        issues: page > 1 && current?.key === queryKey ? mergeIssuePages(current.issues, response.issues) : response.issues,
      }));
      if (page === 1) setSelected(new Set());
    } catch (caught) {
      setError(t(githubErrorKey(errorCode(caught))));
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!listing || !selected.size) return;
    setBusy("importing");
    setError(null);
    try {
      const result = await importGitHubIssues({
        repository: listing.response.repository.fullName,
        projectId: destinationId,
        numbers: [...selected],
      });
      await queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
      setListing({ ...listing, issues: markImported(listing.issues, result) });
      setSelected(new Set());
      if (result.created.length) {
        announce({ message: t("github_import.toast_imported", { count: result.created.length }), tone: "success" });
      }
      if (result.failed.length) {
        setError(t("github_import.partial_failure", {
          count: result.failed.length,
          reason: t(githubErrorKey(result.failed[0]?.reason)),
        }));
      } else if (!result.created.length) {
        setError(t("github_import.nothing_imported"));
      } else {
        onClose();
      }
    } catch (caught) {
      setError(t(githubErrorKey(errorCode(caught))));
    } finally {
      setBusy(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (query.repository && !busy) void load(1);
  }

  const stale = listing !== null && listing.key !== queryKey;
  const issues = stale ? [] : listing?.issues ?? [];
  const importable = importableIssues(issues);
  const allSelected = allImportableSelected(selected, issues);

  return (
    <Drawer
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={t("github_import.title")}
      subtitle={chosenProject ? t("github_import.into_project", { project: chosenProject.name }) : t("github_import.into_intake")}
      width="detail"
      closeLabel={t("github_import.close")}
      bodyClassName="github-import"
    >
      <GitHubConnectionPanel />
      <form className="github-import-query" onSubmit={submit}>
        <Field label={t("github_import.repository")} required hint={t("github_import.repository_hint")}>
          <Input
            data-modal-initial-focus
            required
            autoComplete="off"
            spellCheck={false}
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="owner/repository"
          />
        </Field>
        {lockedProject ? null : (
          <Field label={t("project.project")} labelId={projectLabelId} wrapper="div" hint={t("github_import.project_hint")}>
            <Select value={projectId ?? NO_PROJECT} onValueChange={(value) => {
              if (value) setProjectId(value === NO_PROJECT ? undefined : value);
            }}>
              <SelectTrigger className="w-full" aria-labelledby={projectLabelId}>
                <SelectValue>{() => chosenProject?.name ?? t("issues.no_project")}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROJECT}>{t("issues.no_project")}</SelectItem>
                {openProjects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        )}
        <div className="github-import-filters">
          <Field label={t("github_import.state")} labelId={stateLabelId} wrapper="div">
            <div className="adm-profile-segment" role="group" aria-labelledby={stateLabelId}>
              {STATES.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="adm-profile-segment-btn"
                  data-active={state === option ? "true" : "false"}
                  aria-pressed={state === option}
                  onClick={() => setState(option)}
                >
                  {t(`github_import.states.${option}`)}
                </button>
              ))}
            </div>
          </Field>
          <Field label={t("github_import.labels")} optional={t("github_import.optional")}>
            <Input
              autoComplete="off"
              spellCheck={false}
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
              placeholder="bug,good first issue"
            />
          </Field>
        </div>
        <div>
          <Button type="submit" variant="outline" disabled={!query.repository || busy !== null}>
            {busy === "loading" ? t("github_import.loading") : t("github_import.load")}
          </Button>
        </div>
      </form>

      {listing && !stale ? (
        <section className="github-import-results" aria-label={t("github_import.issues_label")}>
          <header className="github-import-results-head">
            <label className="github-import-select-all">
              <Checkbox
                checked={allSelected}
                disabled={!importable.length || busy !== null}
                onCheckedChange={() => setSelected((current) => toggleAllImportable(current, issues))}
                aria-label={t("github_import.select_all")}
              />
              <span>{t("github_import.selected", { count: selected.size, total: importable.length })}</span>
            </label>
            <span className="github-import-repo" translate="no">{listing.response.repository.fullName}</span>
          </header>
          {issues.length ? (
            <ul className="github-import-list">
              {issues.map((issue) => (
                <IssueRow
                  key={issue.number}
                  issue={issue}
                  checked={selected.has(issue.number)}
                  disabled={busy !== null || (!selected.has(issue.number) && selected.size >= MAX_IMPORT_ISSUES)}
                  onToggle={() => setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(issue.number)) next.delete(issue.number);
                    else next.add(issue.number);
                    return next;
                  })}
                  onOpenTask={onOpenTask}
                />
              ))}
            </ul>
          ) : (
            <p className="github-import-empty">{t("github_import.no_issues")}</p>
          )}
          {listing.response.hasMore ? (
            <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void load(listing.response.page + 1)}>
              {t("github_import.load_more")}
            </Button>
          ) : null}
        </section>
      ) : null}

      {error ? <p role="alert" className="github-import-error">{error}</p> : null}

      <footer className="adm-form-actions">
        <Button variant="ghost" disabled={busy !== null} onClick={onClose}>
          {t("github_import.cancel")}
        </Button>
        <Button disabled={!selected.size || busy !== null || stale} onClick={() => void runImport()}>
          {busy === "importing"
            ? t("github_import.importing")
            : t("github_import.import", { count: selected.size })}
        </Button>
      </footer>
    </Drawer>
  );
}

function IssueRow({ issue, checked, disabled, onToggle, onOpenTask }: {
  issue: GitHubIssuePreview;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const href = safeGitHubUrl(issue.url);
  const imported = issue.importedTaskId;
  return (
    <li className="github-import-row" data-imported={imported ? "true" : undefined}>
      {imported ? (
        <span className="github-import-row-mark" aria-hidden="true" />
      ) : (
        <Checkbox checked={checked} disabled={disabled} onCheckedChange={onToggle}
          aria-label={t("github_import.select_issue", { number: issue.number, title: issue.title })} />
      )}
      <span className="github-import-row-number" translate="no">#{issue.number}</span>
      <span className="github-import-row-main">
        {href ? (
          <a className="github-import-row-title" href={href} target="_blank" rel="noopener noreferrer">{issue.title}</a>
        ) : (
          <span className="github-import-row-title">{issue.title}</span>
        )}
        {issue.labels.length ? (
          <span className="github-import-row-labels">
            {issue.labels.slice(0, 4).map((label) => <span key={label} className="github-import-label">{label}</span>)}
          </span>
        ) : null}
      </span>
      {imported ? (
        onOpenTask ? (
          <button type="button" className="github-import-row-state" onClick={() => onOpenTask(imported)}>
            {t("github_import.imported")}
          </button>
        ) : <span className="github-import-row-state">{t("github_import.imported")}</span>
      ) : (
        <span className="github-import-row-state" data-state={issue.state}>{t(`github_import.states.${issue.state}`)}</span>
      )}
    </li>
  );
}
