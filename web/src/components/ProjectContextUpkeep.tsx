"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { setupNeedsAttention } from "../lib/projectSetup";
import type { ProjectContextSuggestion, ProjectRecord, ProjectSetupMode } from "../types";
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

/** Ask an agent to review the crew, context, and goal against the work so
 *  far (`setup`), or to plan the project's next tasks in order (`plan`).
 *  Either proposal lands in the same review panel a new project's setup
 *  does; nothing changes until the owner applies it. */
export function ProjectRefineSection({
  project,
  onStarted,
  mode = "setup",
}: {
  project: ProjectRecord;
  onStarted: () => void;
  mode?: ProjectSetupMode;
}) {
  const { t } = useTranslation();
  const { startProjectSetupMutation } = useRelayMutations();
  const [note, setNote] = useState("");
  const keys = mode === "plan" ? PLAN_KEYS : REFINE_KEYS;
  const open = setupNeedsAttention(project.setup);
  const closed = Boolean(project.archivedAt) || !project.enabled;
  // A plan builds on the crew; the lead drafts it.
  const uncrewed = mode === "plan" && !project.leadAgentId;
  const blocked = open || closed || uncrewed;

  async function start() {
    try {
      await startProjectSetupMutation.mutateAsync({
        projectId: project.id,
        input: { intent: note.trim() || t(keys.defaultIntent), ...(mode === "plan" ? { mode } : {}) },
      });
      setNote("");
      onStarted();
    } catch {
      // The shared mutation handler announces the error; keep the note.
    }
  }

  return (
    <section className="project-settings-section" aria-labelledby={`project-settings-${mode}`}>
      <header className="project-settings-head">
        <h2 id={`project-settings-${mode}`} className="workspace-dossier-section-title">{t(keys.title)}</h2>
        <p className="project-settings-hint">
          {t(open ? "project.refine_open" : uncrewed ? "project.plan_needs_crew" : keys.hint)}
        </p>
      </header>
      <fieldset className="project-settings-fields" disabled={blocked || startProjectSetupMutation.isPending}>
        <Field label={t(keys.note)}>
          <Textarea
            name={`project-${mode}-note`}
            rows={2}
            maxLength={4000}
            placeholder={t(keys.placeholder)}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </fieldset>
      <footer className="project-settings-foot">
        <span />
        <div className="project-settings-actions">
          <Button type="button" variant="outline" disabled={blocked} loading={startProjectSetupMutation.isPending} onClick={() => void start()}>
            {t(keys.start)}
          </Button>
        </div>
      </footer>
    </section>
  );
}

const REFINE_KEYS = {
  title: "project.refine_title",
  hint: "project.refine_hint",
  note: "project.refine_note",
  placeholder: "project.refine_placeholder",
  start: "project.refine_start",
  defaultIntent: "project.refine_default_intent",
} as const;

const PLAN_KEYS = {
  title: "project.plan_title",
  hint: "project.plan_hint",
  note: "project.plan_note",
  placeholder: "project.plan_placeholder",
  start: "project.plan_start",
  defaultIntent: "project.plan_default_intent",
} as const;
