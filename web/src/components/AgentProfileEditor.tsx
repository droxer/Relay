"use client";

import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  ActionEdit,
  ICON,
} from "./icons";
import { Markdown } from "./LazyMarkdown";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { AgentRoleSelect } from "./agents/AgentRoleSelect";
import { AgentModelField } from "./agents/AgentModelField";
import { modelHintKey, modelIdProblem } from "../lib/agentModels.ts";
import { profileDraftDirty, type AgentProfileDraft } from "../lib/agentProfileDraft.ts";
import type { AgentName } from "../types";

/** What the agent's computer lets the model field offer. */
export interface AgentProfileModelContext {
  executorKind: AgentName;
  /** False when the agent's daemon cannot pass a model on; resetting stays allowed. */
  canSelectModel: boolean;
  models?: readonly string[];
  customEndpoint: boolean;
}

interface AgentProfileEditorProps {
  saved: AgentProfileDraft;
  draft: AgentProfileDraft;
  modelContext: AgentProfileModelContext;
  editing: boolean;
  editable: boolean;
  saving: boolean;
  onStartEdit: () => void;
  onDraftChange: (draft: AgentProfileDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}

/**
 * The agent's profile document, and — in edit mode — the one form that
 * changes it: name, role, model, and instructions, saved together.
 */
export function AgentProfileEditor({
  saved,
  draft,
  modelContext,
  editing,
  editable,
  saving,
  onStartEdit,
  onDraftChange,
  onCancel,
  onSave,
}: AgentProfileEditorProps) {
  const { t } = useTranslation();
  const savedPersonality = saved.instructions.trim();
  const hasCustomPersonality = savedPersonality.length > 0;
  const dirty = profileDraftDirty(saved, draft);
  const nameError = draft.name.trim().length === 0 ? t("admin.v2.edit_user_name_required") : null;
  const modelProblem = modelIdProblem(draft.model);
  const canSave = dirty && !nameError && !modelProblem;
  // With nothing pinned there is nothing to change on an outdated daemon; a
  // pinned model stays editable so the owner can reset it to the default.
  const modelLocked = !modelContext.canSelectModel && !saved.model;
  const modelHint = modelContext.canSelectModel
    ? t(modelHintKey(modelContext.executorKind, { customEndpoint: modelContext.customEndpoint }))
    : t(saved.model ? "agents_page.model_daemon_outdated_pinned" : "agents_page.model_daemon_outdated");

  const titleId = useId();
  const helpId = useId();
  const roleLabelId = useId();
  const modelLabelId = useId();
  const nameErrorId = useId();
  const modelErrorId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && window.matchMedia("(pointer: fine)").matches) {
      nameRef.current?.focus();
    }
  }, [editing]);

  // Same discard guard as CreateAgentDialog: confirm before throwing away a
  // dirty draft, stay instant when there is nothing to lose.
  const confirmDiscardChanges = useUnsavedChangesGuard(editing && dirty && !saving);

  async function requestCancel() {
    if (saving) return;
    if (await confirmDiscardChanges()) onCancel();
  }

  function update(patch: Partial<AgentProfileDraft>) {
    onDraftChange({ ...draft, ...patch });
  }

  return (
    <section
      className={`agent-personality-card${editing ? " is-editing" : ""}`}
      aria-labelledby={titleId}
    >
      <div className="agent-personality-card-head">
        <div className="agent-personality-title-block">
          <div className="agent-personality-title-row">
            <h2 id={titleId}>{t("agents_page.personality_title")}</h2>
            {/* Where the personality comes from, not a state: plain words,
                no badge and no tone dot. */}
            <span className="agent-personality-source">
              {hasCustomPersonality
                ? t("agents_page.personality_defined")
                : t("agents_page.personality_default")}
            </span>
          </div>
          <span id={helpId} className="agent-personality-help">
            {t("agents_page.personality_help")}
          </span>
        </div>
        {editable && !editing ? (
          <Button
            type="button"
            // Always the quiet outline tier — the accent default made a
            // secondary record action the loudest thing on the profile page.
            variant="outline"
            size="dense"
            className="agent-personality-edit-action"
            onClick={onStartEdit}
          >
            <ActionEdit size={ICON.sm} aria-hidden="true" />
            {hasCustomPersonality
              ? t("agents_page.edit_profile")
              : t("agents_page.write_profile")}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <form
          className="agent-personality-editor"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) onSave();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") void requestCancel();
          }}
        >
          <div className="agent-profile-fields">
            <Field label={t("admin.v2.agent_name")} error={nameError ?? undefined} errorId={nameErrorId}>
              <Input
                ref={nameRef}
                name="agent-profile-name"
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                aria-invalid={Boolean(nameError) || undefined}
                aria-describedby={nameError ? nameErrorId : undefined}
                disabled={saving}
              />
            </Field>
            {/* A team keeps its own role for the member, so changing this
                does not rewrite a team the agent already belongs to. */}
            <Field label={t("admin.v2.agent_role_label")} labelId={roleLabelId} wrapper="div">
              <AgentRoleSelect
                value={draft.role}
                onChange={(role) => update({ role })}
                labelledBy={roleLabelId}
                disabled={saving}
              />
            </Field>
            <Field
              className="agent-profile-fields-wide"
              label={t("agents_page.model_label")}
              labelId={modelLabelId}
              wrapper="div"
              hint={modelHint}
              error={modelProblem ? t(`agents_page.model_error_${modelProblem}`) : undefined}
              errorId={modelErrorId}
            >
              <AgentModelField
                value={draft.model}
                onChange={(model) => update({ model })}
                models={modelContext.models}
                customEndpoint={modelContext.customEndpoint}
                labelId={modelLabelId}
                disabled={saving || modelLocked}
                error={Boolean(modelProblem)}
                errorId={modelErrorId}
              />
            </Field>
          </div>
          <Textarea
            className="agent-personality-textarea"
            name="agent-personality"
            aria-label={t("agents_page.personality_title")}
            aria-describedby={helpId}
            rows={14}
            autoComplete="off"
            spellCheck
            value={draft.instructions}
            onChange={(event) => update({ instructions: event.target.value })}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSave) {
                event.preventDefault();
                onSave();
              }
            }}
            disabled={saving}
            placeholder={t("agents_page.personality_placeholder")}
          />
          <div className="agent-personality-editor-foot">
            {!draft.instructions.trim() ? (
              <Button
                variant="ghost"
                size="dense"
                type="button"
                onClick={() => update({ instructions: t("agents_page.personality_starter") })}
                disabled={saving}
              >
                {t("agents_page.personality_starter_action")}
              </Button>
            ) : <span />}
            <div className="agent-personality-actions">
              <Button type="button" variant="ghost" size="dense" onClick={() => { void requestCancel(); }} disabled={saving}>
                {t("admin.v2.cancel")}
              </Button>
              <Button type="submit" size="dense" disabled={!canSave} loading={saving} loadingLabel={t("admin.v2.saving")}>
                {t("agents_page.save_profile")}
              </Button>
            </div>
          </div>
        </form>
      ) : hasCustomPersonality ? (
        <article className="agent-personality-document">
          <Markdown text={savedPersonality} variant="document" />
        </article>
      ) : (
        <div className="agent-personality-empty">
          <p className="agent-personality-empty-lede">{t("agents_page.personality_empty_help")}</p>
        </div>
      )}
    </section>
  );
}
