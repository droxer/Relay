"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/ui/field";
import { ActionRemove, ICON } from "../icons";
import { TagBadge } from "../TaskTags";
import { MAX_TAGS, addTags, hasTag, removeTag } from "../../lib/taskTags";

/**
 * The drawer's tag editor, as one control: an input-shaped box holding the
 * task's tag badges and, after them, the text the next tag is typed into.
 * Enter or a comma adds a tag (a pasted "a, b" adds both); Backspace in the
 * empty input removes the last one. `suggestions` — every tag already in use
 * on the page — are offered through a native datalist, so filing a task
 * under an existing tag never means retyping it in a slightly different
 * spelling.
 */
export function TaskTagsField({
  tags,
  suggestions = [],
  name,
  disabled = false,
  onChange,
}: {
  tags: string[];
  suggestions?: readonly string[];
  name: string;
  disabled?: boolean;
  onChange: (tags: string[]) => void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const listId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const full = tags.length >= MAX_TAGS;
  const offered = suggestions.filter((tag) => !hasTag(tags, tag));

  function commit(value: string): void {
    const next = addTags(tags, value);
    if (next.length !== tags.length) onChange(next);
    setDraft("");
  }

  function remove(tag: string): void {
    onChange(removeTag(tags, tag));
    // The button that was clicked is gone; keep the reader in the field.
    inputRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter" || event.key === ",") {
      // Enter must not submit the drawer's form while a tag is being typed.
      if (event.key === "," || draft.trim()) event.preventDefault();
      if (draft.trim()) commit(draft);
      return;
    }
    if (event.key === "Backspace" && !draft && tags.length) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <Field label={t("tags.label")} htmlFor={inputId} wrapper="div">
      {/* A click on the box's empty space lands in the input, as it would
          on a plain text field; the badges' own buttons keep their clicks. */}
      <div
        className="tag-field"
        data-disabled={disabled || undefined}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {tags.map((tag) => (
          <TagBadge key={tag} tag={tag} className="tag-badge--removable">
            <button
              type="button"
              className="tag-badge-remove"
              disabled={disabled}
              aria-label={t("tags.remove", { tag })}
              onClick={() => remove(tag)}
            >
              <ActionRemove size={ICON.xs} aria-hidden="true" />
            </button>
          </TagBadge>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          name={name}
          className="tag-field-input"
          autoComplete="off"
          list={offered.length ? listId : undefined}
          value={draft}
          disabled={disabled || full}
          placeholder={full ? t("tags.limit", { count: MAX_TAGS }) : tags.length ? t("tags.placeholder_more") : t("tags.placeholder")}
          aria-describedby={hintId}
          onChange={(event) => {
            const value = event.target.value;
            // A paste that carries a comma commits every piece at once.
            if (value.includes(",")) commit(value);
            else setDraft(value);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (draft.trim()) commit(draft);
          }}
        />
        {offered.length ? (
          <datalist id={listId}>
            {offered.map((tag) => <option key={tag} value={tag} />)}
          </datalist>
        ) : null}
      </div>
      <p id={hintId} className="m-0 text-xs leading-snug text-muted-foreground">{t("tags.hint")}</p>
    </Field>
  );
}
