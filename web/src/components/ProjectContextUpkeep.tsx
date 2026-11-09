"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getProject, RelayApiError } from "../api";
import { useRelayMutations } from "../hooks/useRelayMutations";
import type { ProjectContextSuggestion, ProjectRecord } from "../types";
import { Button } from "@/components/ui/button";

/** Context lines project runs proposed, reviewed where the project's other
 *  agent proposals are: on the Dashboard. There is no draft to stage a choice
 *  in here, so each one commits at once — adopting appends the line to the
 *  context and resolves it in the same revision, dismissing only resolves it.
 *  A concurrent edit refetches the project and retries once against it, so an
 *  appended line never overwrites a newer context. */
export function ProjectContextSuggestions({
  project,
  readOnly,
  onOpenThread,
}: {
  project: ProjectRecord;
  readOnly: boolean;
  onOpenThread?: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const { updateProjectMutation } = useRelayMutations();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const suggestions = project.contextSuggestions ?? [];
  if (suggestions.length === 0) return null;

  async function resolve(suggestion: ProjectContextSuggestion, adopt: boolean) {
    if (pendingId) return;
    setPendingId(suggestion.id);
    setError(null);
    const patch = (record: ProjectRecord) => ({
      expectedVersion: record.version,
      resolveContextSuggestions: [suggestion.id],
      ...(adopt ? { context: contextWithSuggestion(record.context ?? "", suggestion.text) } : {}),
    });
    try {
      try {
        await updateProjectMutation.mutateAsync({ projectId: project.id, input: patch(project) });
      } catch (cause) {
        if (!(cause instanceof RelayApiError) || cause.code !== "project_version_conflict") throw cause;
        const { project: latest } = await getProject(project.id);
        // Someone else already settled it; the next poll drops the row.
        if (!(latest.contextSuggestions ?? []).some((item) => item.id === suggestion.id)) return;
        await updateProjectMutation.mutateAsync({ projectId: project.id, input: patch(latest) });
      }
    } catch (cause) {
      /* The shared mutation handler announces ordinary failures; a second
         conflict and a failed refetch are announced here. */
      if (cause instanceof RelayApiError && cause.code === "project_version_conflict") {
        setError(t("project.context_suggestion_conflict"));
      } else if (!(cause instanceof RelayApiError)) {
        setError(t("errors.save_project"));
      }
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="project-settings-section project-dashboard-panel" aria-labelledby="project-context-suggestions">
      <header className="project-settings-head">
        <h2 id="project-context-suggestions" className="workspace-dossier-section-title project-dashboard-panel-title">
          {t("project.context_suggestions")}
          <span className="project-dashboard-count tnum">{suggestions.length}</span>
        </h2>
        <p className="project-settings-hint">{t("project.context_suggestions_hint")}</p>
      </header>
      <ul className="project-dashboard-suggestions">
        {suggestions.map((suggestion) => (
          <li key={suggestion.id} className="project-dashboard-suggestion">
            <p className="project-setup-rationale">{suggestion.text}</p>
            {suggestion.evidence || (onOpenThread && suggestion.threadId) ? (
              <p className="project-settings-hint project-dashboard-suggestion-meta">
                {suggestion.evidence ? (
                  <span>{t("project.context_suggestion_evidence", { evidence: suggestion.evidence })}</span>
                ) : null}
                {onOpenThread && suggestion.threadId ? (
                  <button
                    type="button"
                    className="project-dashboard-suggestion-source"
                    onClick={() => onOpenThread(suggestion.threadId)}
                  >
                    {t("project.context_suggestion_source")}
                  </button>
                ) : null}
              </p>
            ) : null}
            {readOnly ? null : (
              <div className="project-dashboard-suggestion-actions">
                <span className="project-settings-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="dense"
                    disabled={pendingId !== null}
                    onClick={() => void resolve(suggestion, false)}
                  >
                    {t("project.context_suggestion_dismiss")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="dense"
                    disabled={pendingId !== null}
                    loading={pendingId === suggestion.id}
                    onClick={() => void resolve(suggestion, true)}
                  >
                    {t("project.context_suggestion_adopt")}
                  </Button>
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error ? <p role="alert" className="project-settings-error text-destructive">{error}</p> : null}
    </section>
  );
}

/** Add an adopted line to the context as one bullet. */
export function contextWithSuggestion(context: string, text: string): string {
  const base = context.trimEnd();
  return base ? `${base}\n- ${text}` : `- ${text}`;
}
