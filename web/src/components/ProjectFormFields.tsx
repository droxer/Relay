"use client";

import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Backend cap on a project's description (PROJECT_DESCRIPTION_MAX_LENGTH). */
const PROJECT_DESCRIPTION_MAX_LENGTH = 4000;
const PROJECT_NAME_MAX_LENGTH = 120;

/** The project's name, shared by the create drawer and the Settings tab so the
 *  two cannot drift on limits, ids, or error wiring. */
export function ProjectNameField({
  value,
  error,
  inputRef,
  autoFocus = false,
  onChange,
}: {
  value: string;
  error: string | null;
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field label={t("project.name")} error={error ?? undefined} errorId="project-name-error">
      <Input
        ref={inputRef}
        data-modal-initial-focus={autoFocus || undefined}
        className="project-name-input"
        name="project-name"
        autoComplete="off"
        maxLength={PROJECT_NAME_MAX_LENGTH}
        placeholder={t("project.setup_name_placeholder")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? "project-name-error" : undefined}
      />
    </Field>
  );
}

export function ProjectDescriptionField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field label={t("project.description")} hint={t("project.description_hint")}>
      <Textarea
        name="project-description"
        rows={4}
        maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
        placeholder={t("project.description_placeholder")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
