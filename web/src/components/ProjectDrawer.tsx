"use client";

import { useId, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useUserAgents } from "../hooks/useUserAgents";
import { useRelayMutations } from "../hooks/useRelayMutations";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { computerId as stableComputerId } from "../lib/createAgent";
import { agentsEligibleForProject } from "../lib/projectPage";
import { provisionalProjectName } from "../lib/projectSetup";
import type { DaemonNodeMonitorRecord, UserAgent, ProjectRecord } from "../types";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/Drawer";
import { Field } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ProjectDescriptionField, ProjectNameField } from "./ProjectFormFields";
import { RosterAgentItem, RosterEmptyOption, RosterTriggerValue } from "./roster/RosterOption";

/** Setup intents share the backend cap (SETUP_INTENT_MAX_LENGTH). */
const SETUP_INTENT_MAX_LENGTH = 4000;
/** The select's value for "let the backend pick the setup agent". */
const AUTO_SETUP_AGENT = "";

type Mode = "describe" | "manual";

/* Starting a project. With the owner's agents in reach the drawer opens on
   intent: the owner says what the project is for, and an agent on the chosen
   computer drafts the name, brief, crew, and first tasks for review on the
   project page. "Set up manually" keeps the plain form — name, brief,
   computer — and the crew is then built on the Members tab. Editing an
   existing project happens on its Settings tab; this drawer only creates. */
type ProjectDrawerProps = {
  open: boolean;
  computers: DaemonNodeMonitorRecord[];
  /** The owner whose agents can draft a setup; without it only the manual form is offered. */
  userId?: string;
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
  return props.userId
    ? <ProjectDrawerWithAgents key={generation} {...props} userId={props.userId} />
    : <ProjectDrawerBody key={generation} {...props} agents={NO_AGENTS} />;
}

const NO_AGENTS: UserAgent[] = [];

/** Only the describe flow needs the owner's agents, so only it subscribes. */
function ProjectDrawerWithAgents(props: ProjectDrawerProps & { userId: string }) {
  const { agents } = useUserAgents(props.open ? props.userId : undefined);
  return <ProjectDrawerBody {...props} agents={agents} />;
}

function ProjectDrawerBody({ open, computers, userId, agents, onClose, onSaved, layer }: ProjectDrawerProps & { agents: UserAgent[] }) {
  const { t } = useTranslation();
  const { createProjectMutation, startProjectSetupMutation } = useRelayMutations();
  const [mode, setMode] = useState<Mode>(userId ? "describe" : "manual");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [intent, setIntent] = useState("");
  const [setupAgentId, setSetupAgentId] = useState(AUTO_SETUP_AGENT);
  const [computerId, setComputerId] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [computerError, setComputerError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const intentRef = useRef<HTMLTextAreaElement>(null);
  const computerTriggerRef = useRef<HTMLButtonElement>(null);
  const projectComputers = useMemo(
    () => computers.filter((computer) => computer.capabilities?.includes("project-workspaces")),
    [computers],
  );
  const selectedComputer = projectComputers.find((computer) => computer.id === computerId);
  const setupAgents = useMemo(
    () => (selectedComputer ? agentsEligibleForProject(agents, stableComputerId(selectedComputer), selectedComputer.id) : []),
    [agents, selectedComputer],
  );
  const busy = createProjectMutation.isPending || startProjectSetupMutation.isPending;
  const hasUnsavedChanges = Boolean(name || description || intent || computerId);
  const confirmDiscardChanges = useUnsavedChangesGuard(open && hasUnsavedChanges && !busy);
  const describing = mode === "describe";
  const noSetupAgents = describing && Boolean(selectedComputer) && setupAgents.length === 0;

  async function requestClose() {
    if (busy) return;
    if (await confirmDiscardChanges()) onClose();
  }

  function requireComputer(): boolean {
    if (computerId) return true;
    setComputerError(t("project.computer_required"));
    computerTriggerRef.current?.focus();
    return false;
  }

  async function submitManual() {
    if (!name.trim()) {
      setNameError(t("project.name_required"));
      nameRef.current?.focus();
      return;
    }
    if (!requireComputer()) return;
    const nextDescription = description.trim();
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
  }

  /* The project exists before its setup is drafted, so a setup that cannot
     start still leaves a usable project — its page then offers the manual
     path. The provisional name stands until the owner applies the draft. */
  async function submitDescribed() {
    const brief = intent.trim();
    if (!brief) {
      setIntentError(t("project.setup_intent_required"));
      intentRef.current?.focus();
      return;
    }
    if (!requireComputer()) return;
    const created = await createProjectMutation.mutateAsync({
      name: provisionalProjectName(brief, t("project.setup_fallback_name")),
      description: brief,
      daemonNodeId: computerId,
      leadAgentId: null,
      members: [],
    });
    if (!created) return;
    let project = created.project;
    try {
      const started = await startProjectSetupMutation.mutateAsync({
        projectId: project.id,
        input: { intent: brief, ...(setupAgentId ? { agentId: setupAgentId } : {}) },
      });
      project = started.project;
    } catch {
      // Announced by the shared handler; the project itself was created.
    }
    onClose();
    onSaved(project);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    try {
      await (describing ? submitDescribed() : submitManual());
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
      subtitle={t(describing ? "project.setup_subtitle_describe" : "project.setup_subtitle")}
      width="form"
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
    >
      <form className="adm-form project-setup-form" onSubmit={(event) => void submit(event)} noValidate>
        {describing ? (
          <>
            <Field label={t("project.setup_intent")} hint={t("project.setup_intent_hint")} error={intentError ?? undefined} errorId="project-intent-error">
              <Textarea
                ref={intentRef}
                data-modal-initial-focus
                name="project-intent"
                rows={5}
                maxLength={SETUP_INTENT_MAX_LENGTH}
                placeholder={t("project.setup_intent_placeholder")}
                value={intent}
                onChange={(event) => { setIntent(event.target.value); setIntentError(null); }}
                aria-invalid={Boolean(intentError) || undefined}
                aria-describedby={intentError ? "project-intent-error" : undefined}
              />
            </Field>
            <div className="project-setup-basics-grid">
              <ComputerField
                computers={projectComputers}
                value={computerId}
                error={computerError}
                triggerRef={computerTriggerRef}
                onChange={(value) => { setComputerId(value); setComputerError(null); setSetupAgentId(AUTO_SETUP_AGENT); }}
              />
              <SetupAgentField
                agents={setupAgents}
                value={setupAgentId}
                disabled={!selectedComputer || noSetupAgents}
                hint={noSetupAgents ? t("project.setup_no_agents") : t("project.setup_agent_hint")}
                onChange={setSetupAgentId}
              />
            </div>
          </>
        ) : (
          <>
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
              <ComputerField
                computers={projectComputers}
                value={computerId}
                error={computerError}
                triggerRef={computerTriggerRef}
                onChange={(value) => { setComputerId(value); setComputerError(null); }}
              />
            </div>
            <ProjectDescriptionField value={description} onChange={setDescription} />
          </>
        )}

        <div className="adm-form-actions">
          {userId ? (
            <Button
              size="cta"
              type="button"
              variant="ghost"
              className="project-setup-mode"
              onClick={() => setMode(describing ? "manual" : "describe")}
              disabled={busy}
            >
              {t(describing ? "project.setup_manual" : "project.setup_describe")}
            </Button>
          ) : null}
          <Button size="cta" type="button" variant="ghost" onClick={() => void requestClose()} disabled={busy}>{t("dialog.cancel")}</Button>
          <Button size="cta" type="submit" disabled={busy || noSetupAgents} loading={busy}>
            {t(describing ? "project.setup_draft" : "project.create")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function ComputerField({ computers, value, error, triggerRef, onChange }: {
  computers: DaemonNodeMonitorRecord[];
  value: string;
  error: string | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <Field
      label={t("project.computer")}
      labelId={labelId}
      wrapper="div"
      hint={computers.length === 0 ? t("project.no_computers") : t("project.setup_computer_hint")}
      error={error ?? undefined}
      errorId="project-computer-error"
    >
      <Select value={value} onValueChange={(next) => onChange(next ?? "")}>
        <SelectTrigger
          ref={triggerRef}
          className="w-full project-computer-select"
          disabled={computers.length === 0}
          aria-labelledby={labelId}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? "project-computer-error" : undefined}
        >
          <SelectValue placeholder={t("project.choose_computer")}>
            {(selected: string | null) => {
              const computer = computers.find((item) => item.id === selected);
              return computer ? computer.displayName || computer.id : t("project.choose_computer");
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {computers.map((computer) => <SelectItem key={computer.id} value={computer.id}>{computer.displayName || computer.id}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

function SetupAgentField({ agents, value, disabled, hint, onChange }: {
  agents: UserAgent[];
  value: string;
  disabled: boolean;
  hint: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const selectedAgent = agents.find((agent) => agent.id === value);
  return (
    <Field label={t("project.setup_agent")} labelId={labelId} wrapper="div" hint={hint}>
      <Select value={value} onValueChange={(next) => onChange(next ?? AUTO_SETUP_AGENT)}>
        <SelectTrigger className="w-full" disabled={disabled} aria-labelledby={labelId}>
          {selectedAgent ? <RosterTriggerValue agent={selectedAgent} /> : (
            <SelectValue>{() => t("project.setup_agent_auto")}</SelectValue>
          )}
        </SelectTrigger>
        <SelectContent>
          <RosterEmptyOption value={AUTO_SETUP_AGENT} label={t("project.setup_agent_auto")} />
          {agents.map((agent) => <RosterAgentItem key={agent.id} value={agent.id} agent={agent} />)}
        </SelectContent>
      </Select>
    </Field>
  );
}
