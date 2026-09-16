"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent} from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createAgent, listSandboxes } from "../../api";
import {
  computersForEmployee,
  computerName,
  runtimesForComputer,
  type ComputerOwnership,
  type NodeLike,
} from "../../lib/createAgent";
import { EMPLOYEE_AGENTS_QUERY_KEY } from "../../hooks/useEmployeeAgents";
import { agentLabel } from "../../lib/plan";
import { AGENT_NAMES, AGENT_ROLE_OPTIONS } from "../../types";
import type { AgentName, AgentRole, EmployeeAgent, SandboxRecord } from "../../types";
import { AgentMark } from "../AgentMark";
import { PresetAvatarGrid } from "../PresetAvatarGrid";
import { randomPresetAvatar } from "../../lib/presetAvatars";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Drawer } from "@/components/ui/Drawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import {
  ICON,
  nodeOwnershipIcon,
} from "../icons";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { Alert } from "@/components/ui/alert";

interface CreateAgentDialogProps {
  open: boolean;
  onClose: () => void;
  employeeId: string;
  /** Fires once the agent exists on the backend, so the caller can select it right away. */
  onCreated: (agent: EmployeeAgent) => void;
}

/** GET /sandboxes carries workspaceId (the host machine id) alongside the
 *  fields relay-core's SandboxRecord already types — see
 *  core/computer_identity.py's computer_id() on the backend. */
type SandboxWithWorkspace = SandboxRecord & { workspaceId?: string };

function ComputerOptionLabel({
  kindLabel,
  label,
  ownership,
}: {
  kindLabel: string;
  label: string;
  ownership: ComputerOwnership;
}) {
  const ComputerIcon = nodeOwnershipIcon(ownership);
  return (
    <span className="create-agent-computer-option">
      <ComputerIcon size={ICON.sm} aria-hidden="true" />
      <span className="create-agent-computer-name" translate="no">{label}</span>
      <span className="create-agent-computer-kind">{kindLabel}</span>
    </span>
  );
}

/** Maps a daemon node onto the identity shape createAgent.ts operates on.
 *  `sandbox.agents` is a status-dict keyed by every possible runtime kind
 *  (ready/failed/unknown), not a list of what's installed, so only
 *  `status === "ready"` entries are surfaced as supportedAgents. */
function toNodeLike(sandbox: SandboxWithWorkspace): NodeLike {
  const readyRuntimes = Object.entries(sandbox.agents ?? {})
    .filter(([, status]) => status === "ready")
    .map(([kind]) => kind);
  return {
    id: sandbox.id,
    employeeId: sandbox.employeeId,
    workspaceId: sandbox.workspaceId,
    managedNodeId: sandbox.managedNodeId,
    supportedAgents: readyRuntimes,
    disabledAgents: sandbox.disabledAgents,
  };
}

/**
 * Explicit agent creation: computer -> runtime -> role. Mirrors the shape of
 * ConnectComputerDrawer / ManageExecutorsDrawer rather than inventing a new
 * form pattern. POST /agents is the only write; the computer/runtime
 * options come from the employee-scoped GET /sandboxes already used
 * elsewhere in the app.
 */
export function CreateAgentDialog({ open, onClose, employeeId, onCreated }: CreateAgentDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const computerLabelId = useId();
  const runtimeLabelId = useId();
  const roleLabelId = useId();
  const avatarLabelId = useId();
  const placementHeadingId = useId();
  const identityHeadingId = useId();
  const computerTriggerRef = useRef<HTMLButtonElement>(null);
  const runtimeTriggerRef = useRef<HTMLButtonElement>(null);
  const roleTriggerRef = useRef<HTMLButtonElement>(null);

  const sandboxesQuery = useQuery({
    queryKey: ["create-agent", "sandboxes"],
    queryFn: ({ signal }: { signal: AbortSignal }) => listSandboxes(undefined, signal),
    enabled: open,
  });
  const sandboxes = useMemo(
    () => (sandboxesQuery.data?.sandboxes ?? []) as SandboxWithWorkspace[],
    [sandboxesQuery.data],
  );
  const nodeLikes = useMemo(() => sandboxes.map(toNodeLike), [sandboxes]);

  const computerOptions = useMemo(() => {
    return computersForEmployee(nodeLikes, employeeId).map((group) => {
      const primary = sandboxes.find((sandbox) => group.nodes.some((node) => node.id === sandbox.id));
      return {
        computerId: group.computerId,
        ownership: group.ownership,
        label: primary ? computerName(primary) : group.computerId,
      };
    });
  }, [nodeLikes, sandboxes, employeeId]);

  const [computerId, setComputerId] = useState("");
  const [executorKind, setExecutorKind] = useState<AgentName | "">("");
  const [defaultRole, setDefaultRole] = useState<AgentRole | "">("");
  const [displayName, setDisplayName] = useState("");
  const [profileImageUrl, setProfileImageUrl] = useState(() => randomPresetAvatar("agents"));
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    computerId?: string;
    executorKind?: string;
    defaultRole?: string;
  }>({});
  const [isBusy, setIsBusy] = useState(false);

  function clearFieldError(field: "computerId" | "executorKind" | "defaultRole") {
    setFieldErrors((previous) => {
      if (!(field in previous)) return previous;
      const next = { ...previous };
      delete next[field];
      return next;
    });
  }

  function selectRuntime(kind: AgentName) {
    setExecutorKind(kind);
    clearFieldError("executorKind");
  }

  const runtimeOptions = useMemo(
    (): AgentName[] =>
      computerId
        ? runtimesForComputer(nodeLikes, computerId).filter((kind): kind is AgentName =>
            AGENT_NAMES.includes(kind as AgentName),
          )
        : [],
    [nodeLikes, computerId],
  );

  useEffect(() => {
    if (open) {
      setComputerId("");
      setExecutorKind("");
      setDefaultRole("");
      setDisplayName("");
      setProfileImageUrl(randomPresetAvatar("agents"));
      setError(null);
      setFieldErrors({});
      setIsBusy(false);
    }
  }, [open]);

  // The runtime picked for a previous computer may not exist on the newly
  // selected one — drop it rather than silently submitting a stale pick.
  // A computer with exactly one ready runtime gets it pre-selected; there is
  // nothing to choose.
  useEffect(() => {
    if (executorKind && !runtimeOptions.includes(executorKind)) {
      setExecutorKind(runtimeOptions.length === 1 ? runtimeOptions[0] : "");
    } else if (!executorKind && runtimeOptions.length === 1) {
      setExecutorKind(runtimeOptions[0]);
    }
  }, [runtimeOptions, executorKind]);

  const hasUnsavedChanges = Boolean(
    computerId || executorKind || defaultRole || displayName.trim(),
  );
  const confirmDiscardChanges = useUnsavedChangesGuard(open && hasUnsavedChanges && !isBusy);

  // While the computer list is still loading the select is disabled; say so
  // instead of showing the same placeholder as the empty selection state.
  const computerPlaceholder = sandboxesQuery.isLoading
    ? t("admin.loading")
    : t("agents_page.create_computer_placeholder");

  async function requestClose() {
    if (isBusy) return;
    if (await confirmDiscardChanges()) onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!computerId || !executorKind || !defaultRole) {
      const nextErrors: typeof fieldErrors = {};
      if (!computerId) nextErrors.computerId = t("agents_page.create_computer_required");
      if (!executorKind) nextErrors.executorKind = t("agents_page.create_runtime_required");
      if (!defaultRole) nextErrors.defaultRole = t("agents_page.create_role_required");
      setFieldErrors(nextErrors);
      // Move focus to the first invalid control so keyboard and
      // screen-reader users land on the problem, not back at the top.
      if (!computerId) computerTriggerRef.current?.focus();
      else if (!executorKind) runtimeTriggerRef.current?.focus();
      else roleTriggerRef.current?.focus();
      return;
    }
    setFieldErrors({});
    setError(null);
    setIsBusy(true);
    try {
      const result = await createAgent({
        computerId,
        executorKind,
        defaultRole,
        displayName: displayName.trim() || undefined,
        profileImageUrl,
      });
      await queryClient.invalidateQueries({ queryKey: [EMPLOYEE_AGENTS_QUERY_KEY] });
      onCreated(result.agent);
      onClose();
    } catch (err) {
      setError(t("agents_page.create_error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      kicker={t("agents_page.title")}
      title={t("agents_page.create_title")}
      subtitle={t("agents_page.create_sub")}
      width="form"
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
    >
      <form className="adm-form adm-provision-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <section className="adm-provision-section" aria-labelledby={placementHeadingId}>
          <header className="adm-provision-section-head">
            <h3 id={placementHeadingId} className="adm-provision-section-title">
              {t("agents_page.create_section_placement")}
            </h3>
          </header>
          <Field
            label={t("agents_page.create_computer_label")}
            labelId={computerLabelId}
            wrapper="div"
            error={fieldErrors.computerId}
            errorId="create-agent-computer-error"
          >
            <Select
              value={computerId || null}
              onValueChange={(value) => {
                setComputerId(value ?? "");
                clearFieldError("computerId");
              }}
              disabled={isBusy || sandboxesQuery.isLoading || computerOptions.length === 0}
            >
              <SelectTrigger
                ref={computerTriggerRef}
                data-modal-initial-focus
                className="w-full"
                aria-labelledby={computerLabelId}
                aria-invalid={Boolean(fieldErrors.computerId) || undefined}
                aria-describedby={fieldErrors.computerId ? "create-agent-computer-error" : undefined}
              >
                <SelectValue placeholder={computerPlaceholder}>
                  {(value: string | null) => {
                    const selected = computerOptions.find((option) => option.computerId === value);
                    if (!selected) return computerPlaceholder;
                    return (
                      <ComputerOptionLabel
                        kindLabel={t(`admin.v2.node_ownership_${selected.ownership}`)}
                        label={selected.label}
                        ownership={selected.ownership}
                      />
                    );
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {computerOptions.map((option) => (
                  <SelectItem key={option.computerId} value={option.computerId}>
                    <ComputerOptionLabel
                      kindLabel={t(`admin.v2.node_ownership_${option.ownership}`)}
                      label={option.label}
                      ownership={option.ownership}
                    />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!sandboxesQuery.isLoading && computerOptions.length === 0 ? (
              <p className="adm-form-hint">{t("agents_page.create_computer_empty")}</p>
            ) : null}
          </Field>

          <Field
            label={t("agents_page.create_runtime_label")}
            labelId={runtimeLabelId}
            wrapper="div"
            error={fieldErrors.executorKind}
            errorId="create-agent-runtime-error"
          >
            {/* Roving tabindex, arrow keys, and Home/End used to be written
                out here — the sixth copy of the radio pattern in this app.
                The shared group owns all of it; what is left is the card. */}
            <RadioGroup
              className="create-agent-runtime-picker"
              aria-labelledby={runtimeLabelId}
              aria-invalid={Boolean(fieldErrors.executorKind) || undefined}
              aria-describedby={fieldErrors.executorKind ? "create-agent-runtime-error" : undefined}
              disabled={isBusy || !computerId || runtimeOptions.length === 0}
              value={executorKind || null}
              onValueChange={(value) => selectRuntime(value as AgentName)}
            >
              {runtimeOptions.map((kind, index) => {
                const selected = executorKind === kind;
                return (
                  <RadioGroupChoice
                    key={kind}
                    ref={selected || (!executorKind && index === 0) ? runtimeTriggerRef : undefined}
                    value={kind}
                    className={`create-agent-runtime-option${selected ? " is-selected" : ""}`}
                    aria-label={agentLabel(kind)}
                  >
                    <span className="create-agent-runtime-mark" aria-hidden="true">
                      <AgentMark agent={kind} size={ICON.xl} />
                    </span>
                    <span className="create-agent-runtime-option-copy">
                      <span className="create-agent-runtime-option-name" translate="no">{agentLabel(kind)}</span>
                      <span className="create-agent-runtime-option-meta">{t("agents_page.create_runtime_ready")}</span>
                    </span>
                    <span className="create-agent-runtime-check" aria-hidden="true" />
                  </RadioGroupChoice>
                );
              })}
            </RadioGroup>
            {computerId && runtimeOptions.length === 0 ? (
              <p className="adm-form-hint">{t("agents_page.create_runtime_empty")}</p>
            ) : null}
          </Field>
        </section>

        <section className="adm-provision-section" aria-labelledby={identityHeadingId}>
          <header className="adm-provision-section-head">
            <h3 id={identityHeadingId} className="adm-provision-section-title">
              {t("agents_page.create_section_identity")}
            </h3>
          </header>
          <Field
            label={t("admin.v2.agent_role_label")}
            labelId={roleLabelId}
            wrapper="div"
            error={fieldErrors.defaultRole}
            errorId="create-agent-role-error"
          >
            <Select
              value={defaultRole || null}
              onValueChange={(value) => {
                setDefaultRole((value ?? "") as AgentRole);
                clearFieldError("defaultRole");
              }}
              disabled={isBusy}
            >
              <SelectTrigger
                ref={roleTriggerRef}
                className="w-full"
                aria-labelledby={roleLabelId}
                aria-invalid={Boolean(fieldErrors.defaultRole) || undefined}
                aria-describedby={fieldErrors.defaultRole ? "create-agent-role-error" : undefined}
              >
                <SelectValue placeholder={t("agents_page.create_role_placeholder")}>
                  {(value: string | null) => value
                    ? t(`admin.v2.agent_role.${value}`, { defaultValue: value })
                    : t("agents_page.create_role_placeholder")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {AGENT_ROLE_OPTIONS.map((role) => (
                  <SelectItem key={role} value={role}>
                    {t(`admin.v2.agent_role.${role}`, { defaultValue: role })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("agents_page.create_avatar_label")} labelId={avatarLabelId} wrapper="div">
            <PresetAvatarGrid
              kind="agents"
              value={profileImageUrl}
              onChange={setProfileImageUrl}
              labelledBy={avatarLabelId}
              disabled={isBusy}
            />
          </Field>

          <Field label={t("agents_page.create_name_label")} optional={t("admin.v2.optional")}>
            <Input
              name="create-agent-display-name"
              autoComplete="off"
              spellCheck={false}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={t("agents_page.create_name_placeholder")}
              maxLength={64}
              disabled={isBusy}
            />
          </Field>
        </section>

        {error ? <Alert variant="boxed" render={<div />}>{error}</Alert> : null}

        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={() => { void requestClose(); }} disabled={isBusy}>
            {t("admin.v2.cancel")}
          </Button>
          <Button size="cta" type="submit" loading={isBusy}>
            {isBusy ? t("agents_page.create_creating") : t("agents_page.create_submit")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
