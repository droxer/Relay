"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { modelIdProblem, suggestedModels } from "../../lib/agentModels.ts";
import type { AgentName } from "../../types";
import { AgentModelField } from "./AgentModelField";

interface AgentModelSettingProps {
  executorKind: AgentName;
  /** The saved model id, or "" for the runtime default. */
  savedModel: string;
  labelId: string;
  saving: boolean;
  onSave: (model: string) => Promise<void>;
}

/**
 * The model row on an agent's profile. Picking the default or a suggested
 * model is a complete decision and saves at once; a custom id is typed, so it
 * waits for Enter or Save. Mount with `key={savedModel}` so a saved change
 * resets the draft.
 */
export function AgentModelSetting({ executorKind, savedModel, labelId, saving, onSave }: AgentModelSettingProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(savedModel);
  const errorId = `${labelId}-error`;
  const problem = modelIdProblem(draft);
  const dirty = draft.trim() !== savedModel;
  const suggestions = suggestedModels(executorKind);

  function commit(model: string) {
    if (modelIdProblem(model) || model.trim() === savedModel) return;
    void onSave(model.trim());
  }

  return (
    <div className="agent-model-setting">
      <AgentModelField
        executorKind={executorKind}
        value={draft}
        onChange={(next) => {
          setDraft(next);
          if (next === "" || suggestions.includes(next)) commit(next);
        }}
        onSubmitCustom={() => commit(draft)}
        labelId={labelId}
        disabled={saving}
        error={Boolean(problem)}
        errorId={errorId}
      />
      {problem ? <FieldError id={errorId}>{t(`agents_page.model_error_${problem}`)}</FieldError> : null}
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
