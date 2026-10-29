"use client";

import { useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { checkProjectWorkspace } from "../api";
import { folderPathLooksValid, projectFolderErrorKey } from "../lib/projectFolder";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Backend caps (PROJECT_*_MAX_LENGTH in backend/relay/projects/catalog.py). */
const PROJECT_DESCRIPTION_MAX_LENGTH = 4000;
const PROJECT_GOAL_MAX_LENGTH = 280;
const PROJECT_CONTEXT_MAX_LENGTH = 8000;
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

/** The outcome the project commits to. Every run in the project is told it. */
export function ProjectGoalField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field label={t("project.goal")} hint={t("project.goal_hint")}>
      <Input
        name="project-goal"
        autoComplete="off"
        maxLength={PROJECT_GOAL_MAX_LENGTH}
        placeholder={t("project.goal_placeholder")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** The standing brief every run in the project reads: conventions,
 *  constraints, and what done means. */
export function ProjectContextField({
  value,
  revision,
  onChange,
}: {
  value: string;
  revision?: number;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const hint = revision
    ? `${t("project.context_hint")} ${t("project.context_revision", { revision })}`
    : t("project.context_hint");
  return (
    <Field label={t("project.context")} hint={hint}>
      <Textarea
        name="project-context"
        rows={8}
        maxLength={PROJECT_CONTEXT_MAX_LENGTH}
        placeholder={t("project.context_placeholder")}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

type FolderCheck =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "linkable"; path: string }
  | { kind: "refused"; key: string };

/** An existing folder on the project's computer to use as its workspace.
 *  Empty creates a new folder. Leaving the field asks the computer whether it
 *  would link the path, so a refusal shows before the project is created;
 *  `error` carries the refusal from creating the project itself, and
 *  `unavailable` disables the field with the reason it cannot be used. */
export function ProjectFolderField({
  daemonNodeId,
  value,
  error,
  unavailable = null,
  required = false,
  onChange,
}: {
  daemonNodeId: string;
  value: string;
  error: string | null;
  unavailable?: string | null;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [check, setCheck] = useState<FolderCheck>({ kind: "idle" });
  const latest = useRef(0);
  const path = value.trim();
  const shapeError = folderPathLooksValid(value) ? null : t("project.folder_invalid");
  const refusal = check.kind === "refused" ? t(check.key) : null;
  const shownError = error ?? shapeError ?? refusal;
  const hint = unavailable ?? (check.kind === "checking"
    ? t("project.folder_checking")
    : check.kind === "linkable"
      ? t("project.folder_linkable", { path: check.path })
      : t(required ? "project.existing_folder_hint" : "project.folder_hint"));

  async function verify() {
    if (unavailable || !path || shapeError) return;
    const request = ++latest.current;
    setCheck({ kind: "checking" });
    try {
      const result = await checkProjectWorkspace(daemonNodeId, path);
      if (request === latest.current) setCheck({ kind: "linkable", path: result.workspaceHostPath });
    } catch (failure) {
      if (request !== latest.current) return;
      const key = projectFolderErrorKey(failure);
      // A failure unrelated to the folder (network, auth) leaves the field
      // unjudged; creating the project reports it through the shared handler.
      setCheck(key ? { kind: "refused", key } : { kind: "idle" });
    }
  }

  return (
    <Field
      label={t("project.folder")}
      optional={required ? undefined : t("project.folder_optional")}
      hint={shownError ? undefined : hint}
      error={shownError ?? undefined}
      errorId="project-folder-error"
    >
      <Input
        name="project-folder"
        required={required}
        autoComplete="off"
        spellCheck={false}
        translate="no"
        className="code"
        placeholder={t("project.folder_placeholder")}
        value={value}
        disabled={Boolean(unavailable)}
        onChange={(event) => {
          latest.current += 1;
          setCheck({ kind: "idle" });
          onChange(event.target.value);
        }}
        onBlur={() => { void verify(); }}
        aria-invalid={Boolean(shownError) || undefined}
        aria-describedby={shownError ? "project-folder-error" : undefined}
      />
    </Field>
  );
}
