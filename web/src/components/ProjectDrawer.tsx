"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import type { DaemonNodeMonitorRecord, ProjectRecord } from "../types";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/Drawer";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProjectDescriptionField, ProjectNameField } from "./ProjectFormFields";

/* Starting a project: its name, brief, and the computer it lives on. Editing
   an existing project happens on its Settings tab, and the crew on its
   Members tab — this drawer only creates. */
type ProjectDrawerProps = {
  open: boolean;
  computers: DaemonNodeMonitorRecord[];
  onClose: () => void;
  onSaved: (project: ProjectRecord) => void;
  layer?: number;
};

export function ProjectDrawer(props: ProjectDrawerProps) {
  const [opening, setOpening] = useState({ open: props.open, generation: 0 });
  if (opening.open !== props.open) {
    setOpening({ open: props.open, generation: opening.generation + (props.open ? 1 : 0) });
  }
  // Each opening starts from an empty form.
  const generation = opening.generation + (props.open && !opening.open ? 1 : 0);
  return <ProjectDrawerBody key={generation} {...props} />;
}

function ProjectDrawerBody({ open, computers, onClose, onSaved, layer }: ProjectDrawerProps) {
  const { t } = useTranslation();
  const { createProjectMutation } = useRelayMutations();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [computerId, setComputerId] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [computerError, setComputerError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const computerTriggerRef = useRef<HTMLButtonElement>(null);
  const computerLabelId = useId();
  const projectComputers = useMemo(
    () => computers.filter((computer) => computer.capabilities?.includes("project-workspaces")),
    [computers],
  );
  const busy = createProjectMutation.isPending;
  const hasUnsavedChanges = Boolean(name || description || computerId);
  const confirmDiscardChanges = useUnsavedChangesGuard(open && hasUnsavedChanges && !busy);

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
    if (!computerId) {
      setComputerError(t("project.computer_required"));
      computerTriggerRef.current?.focus();
      return;
    }
    const nextDescription = description.trim();
    try {
      const result = await createProjectMutation.mutateAsync({
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

  return (
    <Drawer
      open={open}
      layer={layer}
      onClose={() => { void requestClose(); }}
      kicker={t("project.setup_kicker")}
      title={t("project.setup_title")}
      subtitle={t("project.setup_subtitle")}
      width="form"
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
    >
      <form className="adm-form project-setup-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="project-setup-basics-grid">
          <ProjectNameField
            value={name}
            error={nameError}
            inputRef={nameRef}
            autoFocus
            onChange={(value) => {
              setName(value);
              setNameError(null);
            }}
          />
          <Field
            label={t("project.computer")}
            labelId={computerLabelId}
            wrapper="div"
            hint={projectComputers.length === 0 ? t("project.no_computers") : t("project.setup_computer_hint")}
            error={computerError ?? undefined}
            errorId="project-computer-error"
          >
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
          </Field>
        </div>

        <ProjectDescriptionField value={description} onChange={setDescription} />

        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={() => void requestClose()} disabled={busy}>{t("dialog.cancel")}</Button>
          <Button size="cta" type="submit" disabled={busy} loading={busy}>{t("project.create")}</Button>
        </div>
      </form>
    </Drawer>
  );
}
