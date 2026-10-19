"use client";

import { useRef, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, XIcon } from "../icons";
import { MODEL_ID_MAX_LENGTH, filterModels, suggestedModels } from "../../lib/agentModels.ts";


interface AgentModelFieldProps {
  /** The pinned model id, or "" for the runtime default. */
  value: string;
  /** Every edit, typed or picked. */
  onChange: (model: string) => void;
  /** A finished choice: a listed model picked, or the field cleared to the default. */
  onPick?: (model: string) => void;
  labelId: string;
  disabled?: boolean;
  errorId?: string;
  error?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** Commits a typed id (Enter while no listed model is highlighted). */
  onSubmitCustom?: () => void;
  /** The models the runtime itself reports on the agent's computer. */
  models?: readonly string[];
  /** The runtime calls a custom endpoint, so vendor ids are not suggested. */
  customEndpoint?: boolean;
}

/**
 * Model picker scoped to one runtime: type to search the models the runtime
 * reports, or keep typing to enter any other id the computer's provider
 * serves. Empty is the runtime default. The listed models are a shortcut, not
 * an allowlist, so the field is free text rather than a closed select.
 */
export function AgentModelField({
  value,
  onChange,
  onPick,
  labelId,
  disabled = false,
  errorId,
  error = false,
  inputRef,
  onSubmitCustom,
  models,
  customEndpoint = false,
}: AgentModelFieldProps) {
  const { t } = useTranslation();
  const suggestions = suggestedModels(models, { customEndpoint });
  const visible = filterModels(suggestions, value);
  const hasSuggestions = suggestions.length > 0;
  // Enter on a highlighted option picks it; only a bare Enter commits the text.
  const highlighted = useRef(false);

  return (
    <Autocomplete.Root
      items={visible}
      filter={null}
      value={value}
      onValueChange={(next, details) => {
        onChange(next);
        // Clearing returns to the default, a finished choice; typing is a draft.
        if (details.reason === "clear-press") onPick?.(next);
      }}
      onItemHighlighted={(item) => { highlighted.current = item !== undefined; }}
      openOnInputClick
      disabled={disabled}
    >
      <Autocomplete.InputGroup className="agent-model-field">
        <Autocomplete.Input
          ref={inputRef}
          name="agent-model"
          aria-labelledby={labelId}
          aria-invalid={error || undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          translate="no"
          maxLength={MODEL_ID_MAX_LENGTH}
          placeholder={hasSuggestions ? t("agents_page.model_search_placeholder") : t("agents_page.model_custom_placeholder")}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || highlighted.current || !onSubmitCustom) return;
            event.preventDefault();
            onSubmitCustom();
          }}
          className={cn(
            "h-(--control-h) w-full min-w-0 rounded-md border border-field bg-background py-2 pl-3 pr-16 text-sm text-foreground transition-[color,box-shadow,border-color] outline-none hover:border-field-hover placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-(--opacity-disabled)",
            "focus-visible:border-ring focus-visible:[outline:var(--focus-outline)] focus-visible:[outline-offset:var(--focus-offset)]",
            "aria-invalid:border-destructive aria-invalid:[outline:var(--focus-outline-danger)] aria-invalid:[outline-offset:var(--focus-offset)]",
          )}
        />
        <span className="agent-model-field-actions">
          {value ? (
            <Autocomplete.Clear className="agent-model-field-button" aria-label={t("agents_page.model_reset")}>
              <XIcon className="size-4" aria-hidden="true" />
            </Autocomplete.Clear>
          ) : null}
          {hasSuggestions ? (
            <Autocomplete.Trigger className="agent-model-field-button" aria-label={t("agents_page.model_browse")}>
              <ChevronDownIcon className="size-4" aria-hidden="true" />
            </Autocomplete.Trigger>
          ) : null}
        </span>
      </Autocomplete.InputGroup>
      {hasSuggestions ? (
        <Autocomplete.Portal>
          <Autocomplete.Positioner sideOffset={4} className="isolate z-(--z-float)">
            <Autocomplete.Popup className="max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-y-auto rounded-md bg-popover p-1 text-popover-foreground shadow-(--shadow-2) transition-[opacity,transform] duration-(--t-fast) ease-(--ease) data-[open]:opacity-100 data-[closed]:opacity-0 data-[closed]:scale-95">
              <Autocomplete.Empty className="px-2 py-1.5 text-dense text-muted-foreground empty:hidden">
                {value.trim() ? t("agents_page.model_no_match", { model: value.trim() }) : null}
              </Autocomplete.Empty>
              <Autocomplete.List>
                {(model: string) => (
                  <Autocomplete.Item
                    key={model}
                    value={model}
                    // Fires for a click and for Enter on the highlighted item.
                    onClick={() => {
                      onChange(model);
                      onPick?.(model);
                    }}
                    className="flex w-full cursor-default items-center rounded-sm px-2 py-1.5 text-dense outline-hidden select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                  >
                    <span translate="no" className="min-w-0 [overflow-wrap:anywhere]">{model}</span>
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      ) : null}
    </Autocomplete.Root>
  );
}
