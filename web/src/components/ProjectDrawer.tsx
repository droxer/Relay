"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useProjectSave } from "../hooks/useProjectSave";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { computerId as stableComputerId } from "../lib/createAgent";
import type {
  DaemonNodeMonitorRecord,
  ProjectRecord,
} from "../types";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Drawer } from "@/components/ui/Drawer";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Backend cap on a project's description (PROJECT_DESCRIPTION_MAX_LENGTH). */
const PROJECT_DESCRIPTION_MAX_LENGTH = 4000;

function projectDraftKey(name: string, description: string, computerId: string): string {
  return JSON.stringify({ name, description, computerId });
}

/* Project settings: the record's identity (name, description, computer) and its danger
   zone. The crew is managed on the project profile page itself — adding and
   editing members lives next to the member cards it changes, not in setup. */
export function ProjectDrawer({
  open,
  computers,
  project,
  onClose,
  onSaved,
  onDeleted,
  layer,
}: {
  open: boolean;
  computers: DaemonNodeMonitorRecord[];
  project?: ProjectRecord | null;
  onClose: () => void;
  onSaved: (project: ProjectRecord) => void;
  onDeleted?: () => void;
  layer?: number;
}) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const { createProjectMutation, updateProjectMutation, archiveProjectMutation, deleteProjectMutation } = useRelayMutations();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [computerId, setComputerId] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [computerError, setComputerError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const computerTriggerRef = useRef<HTMLButtonElement>(null);
  const computerLabelId = useId();
  const initializedKeyRef = useRef<string | null>(null);
  const initialDraftKeyRef = useRef(projectDraftKey("", "", ""));
  const initialProjectRef = useRef(project);
  const projectSave = useProjectSave(updateProjectMutation.mutateAsync);
  const projectComputers = useMemo(
    () => computers.filter((computer) => computer.capabilities?.includes("project-workspaces")),
    [computers],
  );
  const projectRuntimeNodeId = useMemo(() => (
    project
      ? computers.find((computer) => stableComputerId(computer) === project.computerId)?.id ?? ""
      : ""
  ), [computers, project]);
  const selectedComputerId = project ? projectRuntimeNodeId : computerId;
  const selectedComputer = useMemo(
    () => computers.find((computer) => computer.id === selectedComputerId) ?? null,
    [computers, selectedComputerId],
  );
  const selectedComputerLabel = selectedComputer
    ? selectedComputer.displayName || selectedComputer.id
    : project?.computerId ?? "";
  const busy = createProjectMutation.isPending || updateProjectMutation.isPending || archiveProjectMutation.isPending || deleteProjectMutation.isPending || projectSave.pending;

  useEffect(() => {
    if (!open) {
      initializedKeyRef.current = null;
      return;
    }
    const initializationKey = project?.id ?? "new";
    if (initializedKeyRef.current === initializationKey) return;
    initializedKeyRef.current = initializationKey;
    initialProjectRef.current = project;
    projectSave.resetError();
    if (!project) {
      reset();
      initialDraftKeyRef.current = projectDraftKey("", "", "");
      return;
    }
    setName(project.name);
    setDescription(project.description ?? "");
    setComputerId(projectRuntimeNodeId);
    setNameError(null);
    setComputerError(null);
    initialDraftKeyRef.current = projectDraftKey(project.name, project.description ?? "", projectRuntimeNodeId);
  }, [open, project, projectRuntimeNodeId]);
  const hasUnsavedChanges = initializedKeyRef.current !== null
    && projectDraftKey(name, description, computerId) !== initialDraftKeyRef.current;
  const confirmDiscardChanges = useUnsavedChangesGuard(open && hasUnsavedChanges && !busy);

  function reset() {
    setName("");
    setDescription("");
    setComputerId("");
    setNameError(null);
    setComputerError(null);
  }

  async function requestClose() {
    if (busy) return;
    if (await confirmDiscardChanges()) onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setNameError(t("project.name_required"));
      nameRef.current?.focus();
      return;
    }
    if (!project && !selectedComputerId) {
      setComputerError(t("project.computer_required"));
      computerTriggerRef.current?.focus();
      return;
    }
    /* The brief rides the request only when it says something new, so a
       rename never rewrites a description it did not touch. */
    const nextDescription = description.trim();
    const base = initialProjectRef.current ?? project;
    const descriptionChanged = nextDescription !== (base?.description ?? "").trim();
    try {
      const result = project
        ? await projectSave.save(base ?? project, {
            expectedVersion: (base ?? project).version,
            name: name.trim(),
            ...(descriptionChanged ? { description: nextDescription } : {}),
          })
        : await createProjectMutation.mutateAsync({
            name: name.trim(),
            ...(nextDescription ? { description: nextDescription } : {}),
            daemonNodeId: computerId,
            leadAgentId: null,
            members: [],
          });
      if (!result) return;
      onClose();
      onSaved(result.project);
    } catch {
      // The shared mutation handler announces the server error; preserve the form.
    }
  }

  async function archive() {
    if (!project || busy) return;
    const accepted = await confirm({
      title: t("project.archive_confirm_title", { project: project.name }),
      message: t("project.archive_confirm_message"),
      confirmLabel: t("project.archive"),
      tone: "danger",
    });
    if (!accepted) return;
    try {
      const result = await archiveProjectMutation.mutateAsync({
        projectId: project.id,
        expectedVersion: project.version,
      });
      if (!result) return;
      onClose();
      onSaved(result.project);
    } catch {
      // The shared mutation handler announces the error and keeps settings open.
    }
  }

  async function remove() {
    if (!project || busy) return;
    const accepted = await confirm({
      title: t("project.delete_confirm_title", { project: project.name }),
      message: t("project.delete_confirm_message"),
      confirmLabel: t("project.delete"),
      tone: "danger",
    });
    if (!accepted) return;
    try {
      await deleteProjectMutation.mutateAsync({ projectId: project.id, expectedVersion: project.version });
      onClose();
      onDeleted?.();
    } catch {
      // Preserve settings so the user can retry after resolving the error.
    }
  }

  return (
    <Drawer
      open={open}
      layer={layer}
      onClose={() => { void requestClose(); }}
      kicker={t("project.setup_kicker")}
      title={t(project ? "project.edit" : "project.setup_title")}
      subtitle={t(project ? "project.edit_subtitle" : "project.setup_subtitle")}
      width="form"
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
      onClosed={reset}
    >
      <form className="adm-form project-setup-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="project-setup-basics-grid">
          <Field label={t("project.name")} error={nameError ?? undefined} errorId="project-name-error">
            <Input
              ref={nameRef}
              data-modal-initial-focus
              className="project-name-input"
              name="project-name"
              autoComplete="off"
              maxLength={120}
              placeholder={t("project.setup_name_placeholder")}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
              aria-invalid={Boolean(nameError) || undefined}
              aria-describedby={nameError ? "project-name-error" : undefined}
            />
          </Field>
          <Field
            label={t("project.computer")}
            labelId={computerLabelId}
            wrapper="div"
            hint={project ? undefined : projectComputers.length === 0 ? t("project.no_computers") : t("project.setup_computer_hint")}
            error={computerError ?? undefined}
            errorId="project-computer-error"
          >
            {project ? (
              <p className="project-computer-static" translate="no">{selectedComputerLabel}</p>
            ) : (
              <Select value={computerId} onValueChange={(value) => { setComputerId(value ?? ""); setComputerError(null); }}>
                <SelectTrigger
                  ref={computerTriggerRef}
                  className="w-full project-computer-select"
                  disabled={projectComputers.length === 0}
                  aria-labelledby={computerLabelId}
                  aria-invalid={Boolean(computerError) || undefined}
                  aria-describedby={computerError ? "project-computer-error" : undefined}
                >
                  <SelectValue placeholder={t("project.choose_computer")}>
                    {(value: string | null) => {
                      const selected = projectComputers.find((computer) => computer.id === value);
                      return selected ? selected.displayName || selected.id : t("project.choose_computer");
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {projectComputers.map((computer) => <SelectItem key={computer.id} value={computer.id}>{computer.displayName || computer.id}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </Field>
        </div>

        <Field label={t("project.description")} hint={t("project.description_hint")}>
          <Textarea
            name="project-description"
            rows={4}
            maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
            placeholder={t("project.description_placeholder")}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        {project ? (
          <div className="adm-drawer-section">
            <h3 className="adm-drawer-section-title">{t("admin.v2.danger_zone")}</h3>
            <div className="adm-drawer-section-actions">
              <Button type="button" variant="destructive" onClick={() => void archive()} loading={archiveProjectMutation.isPending} loadingLabel={t("project.archiving")} disabled={busy || Boolean(project.archivedAt)}>
                {t("project.archive")}
              </Button>
              <Button type="button" variant="destructive" onClick={() => void remove()} loading={deleteProjectMutation.isPending} loadingLabel={t("project.deleting")} disabled={busy}>
                {t("project.delete")}
              </Button>
            </div>
          </div>
        ) : null}
        {projectSave.error ? <p role="alert" className="text-destructive">{projectSave.error}</p> : null}
        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={() => void requestClose()} disabled={busy}>{t("dialog.cancel")}</Button>
          <Button size="cta" type="submit" disabled={busy || Boolean(project?.archivedAt)} loading={createProjectMutation.isPending || projectSave.pending}>{t(project ? "project.save" : "project.create")}</Button>
        </div>
      </form>
    </Drawer>
  );
}
