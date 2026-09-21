"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getProject, RelayApiError } from "../api";
import { useDialogs } from "../components/ui/DialogProvider";
import { ProjectEditError, rebaseProjectEdit } from "../lib/projectEdit";
import type { ProjectRecord, UpdateProjectInput } from "../types";

type Save = (args: { projectId: string; input: UpdateProjectInput }) => Promise<{ project: ProjectRecord }>;

/** A bounded, explicitly confirmed retry; never overwrite a whole stale roster. */
export function useProjectSave(mutate: Save) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(base: ProjectRecord, input: UpdateProjectInput) {
    if (locked.current) return null;
    locked.current = true;
    setPending(true);
    setError(null);
    try {
      try {
        return await mutate({ projectId: base.id, input });
      } catch (cause) {
        if (!(cause instanceof RelayApiError) || cause.code !== "project_version_conflict") throw cause;
      }
      const { project: latest } = await getProject(base.id);
      const { patch, conflicts } = rebaseProjectEdit(base, input, latest);
      const details = conflicts.map(({ field, member, saved, draft }) => (
        `${member ? `${member} · ` : ""}${t(`project.${field}`)}: ${saved} → ${draft}`
      )).join("\n");
      const accepted = await confirm({
        title: t("project.edit_conflict_title"),
        message: [t("project.edit_conflict_message"), details].filter(Boolean).join("\n\n"),
        confirmLabel: t("project.edit_conflict_retry"),
      });
      if (!accepted) return null;
      return await mutate({ projectId: base.id, input: patch });
    } catch (cause) {
      setError(cause instanceof ProjectEditError ? t(cause.message)
        : cause instanceof RelayApiError && cause.code === "project_version_conflict"
          ? t("project.edit_conflict_again")
          : cause instanceof Error ? cause.message : t("errors.save_project"));
      return null;
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  return { save, pending, error, resetError: () => setError(null) };
}
