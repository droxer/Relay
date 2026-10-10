"use client";

import { useId, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MODEL_ID_MAX_LENGTH, suggestedModels } from "../../lib/agentModels.ts";

/** Select values that are not model ids; real ids cannot start with "_". */
const DEFAULT_CHOICE = "__default__";
const CUSTOM_CHOICE = "__custom__";

interface AgentModelFieldProps {
  /** The pinned model id, or "" for the runtime default. */
  value: string;
  onChange: (model: string) => void;
  labelId: string;
  disabled?: boolean;
  errorId?: string;
  error?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  /** Commits a typed custom id (Enter in the custom input). */
  onSubmitCustom?: () => void;
  /** The models the runtime itself reports on the agent's computer. */
  models?: readonly string[];
  /** The runtime calls a custom endpoint, so vendor ids are not suggested. */
  customEndpoint?: boolean;
}

/**
 * Model picker scoped to one runtime: its default, the models the runtime
 * reports, or any other id the computer's provider serves. The choice is
 * derived from `value`, so only "Custom with nothing typed yet" needs state.
 */
export function AgentModelField({
  value,
  onChange,
  labelId,
  disabled = false,
  errorId,
  error = false,
  triggerRef,
  onSubmitCustom,
  models,
  customEndpoint = false,
}: AgentModelFieldProps) {
  const { t } = useTranslation();
  const customInputId = useId();
  const suggestions = suggestedModels(models, { customEndpoint });
  const [customPicked, setCustomPicked] = useState(false);
  const isCustom = customPicked || (value !== "" && !suggestions.includes(value));
  const choice = isCustom ? CUSTOM_CHOICE : value || DEFAULT_CHOICE;

  function choiceLabel(next: string | null): string {
    if (next === CUSTOM_CHOICE) return t("agents_page.model_custom");
    if (!next || next === DEFAULT_CHOICE) return t("agents_page.model_default");
    return next;
  }

  return (
    <div className="agent-model-field">
      <Select
        value={choice}
        onValueChange={(next) => {
          if (next === CUSTOM_CHOICE) {
            setCustomPicked(true);
            // Keep an already-typed custom id; a suggestion is not a custom id.
            if (suggestions.includes(value)) onChange("");
            return;
          }
          setCustomPicked(false);
          onChange(!next || next === DEFAULT_CHOICE ? "" : next);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          ref={triggerRef}
          className="w-full"
          aria-labelledby={labelId}
          aria-invalid={error || undefined}
          aria-describedby={error && !isCustom ? errorId : undefined}
        >
          <SelectValue>{(next: string | null) => choiceLabel(next)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_CHOICE}>{t("agents_page.model_default")}</SelectItem>
          {suggestions.map((model) => (
            <SelectItem key={model} value={model}>
              <span translate="no">{model}</span>
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_CHOICE}>{t("agents_page.model_custom")}</SelectItem>
        </SelectContent>
      </Select>
      {isCustom ? (
        <Input
          id={customInputId}
          name="agent-model-custom"
          aria-label={t("agents_page.model_custom_label")}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          translate="no"
          maxLength={MODEL_ID_MAX_LENGTH}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && onSubmitCustom) {
              event.preventDefault();
              onSubmitCustom();
            }
          }}
          placeholder={t("agents_page.model_custom_placeholder")}
          aria-invalid={error || undefined}
          aria-describedby={error ? errorId : undefined}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}
