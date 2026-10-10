"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { modelHintKey, modelIdProblem, suggestedModels } from "../../lib/agentModels.ts";
import type { AgentName } from "../../types";
import { AgentModelField } from "./AgentModelField";

interface AgentModelSettingProps {
  executorKind: AgentName;
  /** The saved model id, or "" for the runtime default. */
  savedModel: string;
  labelId: string;
  saving: boolean;
  /** False when the agent's daemon cannot pass a model on; resetting stays allowed. */
  canSelectModel?: boolean;
  /** The models the runtime itself reports on the agent's computer. */
  models?: readonly string[];
  /** The runtime calls a custom model endpoint on its computer. */
  customEndpoint?: boolean;
  onSave: (model: string) => Promise<void>;
}

/**
 * The model row on an agent's profile. Picking the default or a reported
 * model is a complete decision and saves at once; a custom id is typed, so it
 * waits for Enter or Save. Mount with `key={savedModel}` so a saved change
 * resets the draft.
 */
export function AgentModelSetting({
  executorKind,
  savedModel,
  labelId,
  saving,
  canSelectModel = true,
  models,
  customEndpoint = false,
  onSave,
}: AgentModelSettingProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(savedModel);
  const errorId = `${labelId}-error`;
  const hintId = `${labelId}-hint`;
  // With nothing pinned there is nothing to change on an outdated daemon; a
  // pinned model stays editable so the owner can reset it to the default.
  const locked = !canSelectModel && !savedModel;
  const problem = modelIdProblem(draft);
  const dirty = draft.trim() !== savedModel;
  const suggestions = suggestedModels(models, { customEndpoint });
  const hintKey = modelHintKey(executorKind, { customEndpoint });

  function commit(model: string) {
    if (modelIdProblem(model) || model.trim() === savedModel) return;
    void onSave(model.trim());
  }

  return (
    <div className="agent-model-setting">
      <AgentModelField
        value={draft}
        onChange={(next) => {
          setDraft(next);
          if (next === "" || suggestions.includes(next)) commit(next);
        }}
        onSubmitCustom={() => commit(draft)}
        models={models}
        customEndpoint={customEndpoint}
        labelId={labelId}
        disabled={saving || locked}
        error={Boolean(problem)}
        errorId={errorId}
      />
      {problem ? <FieldError id={errorId}>{t(`agents_page.model_error_${problem}`)}</FieldError> : null}
      {!canSelectModel ? (
        <p id={hintId} className="adm-form-hint">
          {savedModel ? t("agents_page.model_daemon_outdated_pinned") : t("agents_page.model_daemon_outdated")}
        </p>
      ) : hintKey !== "agents_page.model_hint" ? (
        // The default hint restates the picker; only runtime-specific advice shows here.
        <p id={hintId} className="adm-form-hint">{t(hintKey)}</p>
      ) : null}
      {dirty && draft.trim() && !suggestions.includes(draft.trim()) ? (
        <div className="agent-model-setting-actions">
          <Button type="button" variant="ghost" size="dense" onClick={() => setDraft(savedModel)} disabled={saving}>
            {t("admin.v2.cancel")}
          </Button>
          <Button
            type="button"
            size="dense"
            onClick={() => commit(draft)}
            disabled={Boolean(problem)}
            loading={saving}
            loadingLabel={t("admin.v2.saving")}
          >
            {t("agents_page.model_save")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
