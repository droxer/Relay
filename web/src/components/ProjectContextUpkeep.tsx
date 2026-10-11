"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { setupNeedsAttention } from "../lib/projectSetup";
import type { ProjectContextSuggestion, ProjectRecord } from "../types";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

/** Context lines project runs proposed. Adopting or dismissing only stages
 *  the choice on the Settings draft; the form's Save commits it with the
 *  edited context, so the context changes in exactly one revision. */
export function ProjectContextSuggestions({
  suggestions,
  disabled,
  onAdopt,
  onDismiss,
}: {
  suggestions: ProjectContextSuggestion[];
  disabled: boolean;
  onAdopt: (suggestion: ProjectContextSuggestion) => void;
  onDismiss: (suggestion: ProjectContextSuggestion) => void;
}) {
  const { t } = useTranslation();
  if (suggestions.length === 0) return null;
  return (
    <div className="project-setup-group" role="group" aria-labelledby="project-context-suggestions">
      <h3 id="project-context-suggestions" className="project-setup-subhead">{t("project.context_suggestions")}</h3>
      <p className="project-settings-hint">{t("project.context_suggestions_hint")}</p>
      <ul className="project-setup-list">
        {suggestions.map((suggestion) => (
          <li key={suggestion.id} className="project-setup-item">
            <p className="project-setup-rationale">{suggestion.text}</p>
            {suggestion.evidence ? (
              <p className="project-settings-hint">{t("project.context_suggestion_evidence", { evidence: suggestion.evidence })}</p>
            ) : null}
            <div className="project-settings-actions">
              <Button type="button" variant="ghost" size="dense" disabled={disabled} onClick={() => onDismiss(suggestion)}>
                {t("project.context_suggestion_dismiss")}
              </Button>
              <Button type="button" variant="outline" size="dense" disabled={disabled} onClick={() => onAdopt(suggestion)}>
                {t("project.context_suggestion_adopt")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Add an adopted line to the context as one bullet. */
export function contextWithSuggestion(context: string, text: string): string {
  const base = context.trimEnd();
  return base ? `${base}\n- ${text}` : `- ${text}`;
}

/** Ask an agent to review the crew, context, and goal against the work so far.
 *  The proposal lands in the same review panel a new project's setup does. */
export function ProjectRefineSection({
  project,
  onStarted,
}: {
  project: ProjectRecord;
  onStarted: () => void;
}) {
  const { t } = useTranslation();
  const { startProjectSetupMutation } = useRelayMutations();
  const [note, setNote] = useState("");
  const open = setupNeedsAttention(project.setup);
  const closed = Boolean(project.archivedAt) || !project.enabled;
  const blocked = open || closed;

  async function start() {
    try {
      await startProjectSetupMutation.mutateAsync({
        projectId: project.id,
        input: { intent: note.trim() || t("project.refine_default_intent") },
      });
      setNote("");
      onStarted();
    } catch {
      // The shared mutation handler announces the error; keep the note.
    }
  }

  return (
    <section className="project-settings-section" aria-labelledby="project-settings-refine">
      <header className="project-settings-head">
        <h2 id="project-settings-refine" className="workspace-dossier-section-title">{t("project.refine_title")}</h2>
        <p className="project-settings-hint">{t(open ? "project.refine_open" : "project.refine_hint")}</p>
      </header>
      <fieldset className="project-settings-fields" disabled={blocked || startProjectSetupMutation.isPending}>
        <Field label={t("project.refine_note")}>
          <Textarea
            name="project-refine-note"
            rows={2}
            maxLength={4000}
            placeholder={t("project.refine_placeholder")}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </fieldset>
      <footer className="project-settings-foot">
        <span />
        <div className="project-settings-actions">
          <Button type="button" variant="outline" disabled={blocked} loading={startProjectSetupMutation.isPending} onClick={() => void start()}>
            {t("project.refine_start")}
          </Button>
        </div>
      </footer>
    </section>
  );
}
