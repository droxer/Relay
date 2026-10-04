"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useProjectSave } from "../hooks/useProjectSave";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import type { ProjectRecord } from "../types";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Field } from "@/components/ui/field";
import { AdminDelete, ICON } from "./icons";
import { ProjectDescriptionField, ProjectNameField } from "./ProjectFormFields";

type Draft = { name: string; description: string };

const draftOf = (project: ProjectRecord): Draft => ({
  name: project.name,
  description: project.description ?? "",
});

/** The Settings tab: the project's identity (name, description; its computer
 *  is fixed) and its danger zone. It replaced the edit mode of the settings
 *  drawer, which now only creates projects.
 *
 *  The draft is edited against a BASE — the record as it stood when editing
 *  began — so a save carries that revision and a concurrent change surfaces
 *  as a conflict instead of being overwritten. While nothing is edited, a
 *  newer record (a poll, an archive) is adopted as the new base. */
export function ProjectSettingsPanel({
  project,
  computerLabel,
  onDeleted,
}: {
  project: ProjectRecord;
  computerLabel: string;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const { updateProjectMutation, archiveProjectMutation, deleteProjectMutation } = useRelayMutations();
  const projectSave = useProjectSave(updateProjectMutation.mutateAsync);
  const [base, setBase] = useState(project);
  const [draft, setDraft] = useState<Draft>(() => draftOf(project));
  const [nameError, setNameError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const computerLabelId = useId();

  const savedDraft = draftOf(base);
  const dirty = draft.name !== savedDraft.name || draft.description !== savedDraft.description;
  if (!dirty && project.version !== base.version) {
    setBase(project);
    setDraft(draftOf(project));
  }

  const busy = projectSave.pending || archiveProjectMutation.isPending || deleteProjectMutation.isPending;
  const archived = Boolean(project.archivedAt);
  useUnsavedChangesGuard(dirty && !busy);

  const adopt = (record: ProjectRecord) => {
    setBase(record);
    setDraft(draftOf(record));
    setNameError(null);
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !dirty) return;
    const name = draft.name.trim();
    if (!name) {
      setNameError(t("project.name_required"));
      nameRef.current?.focus();
      return;
    }
    /* The brief rides the request only when it says something new, so a
       rename never rewrites a description it did not touch. */
    const description = draft.description.trim();
    const descriptionChanged = description !== savedDraft.description.trim();
    const result = await projectSave.save(base, {
      expectedVersion: base.version,
      name,
      ...(descriptionChanged ? { description } : {}),
    });
    if (result) adopt(result.project);
  }

  async function archive() {
    if (busy || archived) return;
    const accepted = await confirm({
      title: t("project.archive_confirm_title", { project: project.name }),
      message: t("project.archive_confirm_message"),
      confirmLabel: t("project.archive"),
      tone: "danger",
    });
    if (!accepted) return;
    try {
      const result = await archiveProjectMutation.mutateAsync({ projectId: project.id, expectedVersion: project.version });
      if (result && !dirty) adopt(result.project);
    } catch {
      // The shared mutation handler announces the error; the panel stays as it was.
    }
  }

  async function remove() {
    if (busy) return;
    const accepted = await confirm({
      title: t("project.delete_confirm_title", { project: project.name }),
      message: t("project.delete_confirm_message"),
      confirmLabel: t("project.delete"),
      tone: "danger",
    });
    if (!accepted) return;
    try {
      await deleteProjectMutation.mutateAsync({ projectId: project.id, expectedVersion: project.version });
      onDeleted();
    } catch {
      // Stay on the panel so the user can retry after resolving the error.
    }
  }

  return (
    <div className="project-profile project-settings">
      <form
        className="project-settings-section"
        aria-labelledby="project-settings-details"
        onSubmit={(event) => void save(event)}
        noValidate
      >
        <header className="project-settings-head">
          <h2 id="project-settings-details" className="workspace-dossier-section-title">
            {t("project.settings_details")}
          </h2>
          <p className="project-settings-hint">
            {t(archived ? "project.settings_archived" : "project.edit_subtitle")}
          </p>
        </header>
        <fieldset className="project-settings-fields" disabled={archived || busy}>
          <ProjectNameField
            value={draft.name}
            error={nameError}
            inputRef={nameRef}
            onChange={(name) => {
              setDraft((current) => ({ ...current, name }));
              setNameError(null);
            }}
          />
          <Field label={t("project.computer")} labelId={computerLabelId} wrapper="div">
            <p className="project-computer-static" aria-labelledby={computerLabelId} translate="no">
              {computerLabel}
            </p>
          </Field>
          <ProjectDescriptionField
            value={draft.description}
            onChange={(description) => setDraft((current) => ({ ...current, description }))}
          />
        </fieldset>
        {projectSave.error ? <p role="alert" className="text-destructive">{projectSave.error}</p> : null}
        <div className="project-settings-actions">
          <Button type="button" variant="ghost" disabled={!dirty || busy} onClick={() => adopt(project)}>
            {t("unsaved.confirm")}
          </Button>
          <Button type="submit" disabled={!dirty || busy || archived} loading={projectSave.pending}>
            {t("project.save")}
          </Button>
        </div>
      </form>

      <section className="project-settings-section" aria-labelledby="project-settings-danger">
        <header className="project-settings-head">
          <h2 id="project-settings-danger" className="workspace-dossier-section-title">
            {t("admin.v2.danger_zone")}
          </h2>
        </header>
        <div className="project-settings-danger">
          <div className="project-settings-danger-row">
            <div className="project-settings-danger-copy">
              <strong>{t("project.archive")}</strong>
              <p>{t("project.archive_confirm_message")}</p>
            </div>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void archive()}
              loading={archiveProjectMutation.isPending}
              loadingLabel={t("project.archiving")}
              disabled={busy || archived}
            >
              {t("project.archive")}
            </Button>
          </div>
          <div className="project-settings-danger-row">
            <div className="project-settings-danger-copy">
              <strong>{t("project.delete")}</strong>
              <p>{t("project.delete_hint")}</p>
            </div>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void remove()}
              loading={deleteProjectMutation.isPending}
              loadingLabel={t("project.deleting")}
              disabled={busy}
            >
              <AdminDelete size={ICON.sm} aria-hidden="true" />
              {t("project.delete")}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
