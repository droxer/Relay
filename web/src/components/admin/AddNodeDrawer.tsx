"use client";

import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { createControlPanelDaemonNode, createManagedNode } from "../../api";
import type {
  CreateControlPanelDaemonNodeResponse,
  CreateManagedNodeResponse,
  EmployeeRecord,
} from "../../types";
import { employeeHandleOf } from "../../lib/employeeHandle";
import { Drawer } from "@/components/ui/Drawer";
import { RunModeField, type RunLocation } from "./RunModeField";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useOnOpen } from "@/hooks/useKeyChange";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";

export type AddNodeDrawerSuccess =
  | { kind: "managed"; result: CreateManagedNodeResponse }
  | { kind: "manual"; result: CreateControlPanelDaemonNodeResponse };

interface AddNodeDrawerProps {
  open: boolean;
  onClose: () => void;
  employees: EmployeeRecord[];
  onSuccess: (outcome: AddNodeDrawerSuccess) => void;
}

export function AddNodeDrawer({
  open,
  onClose,
  employees,
  onSuccess,
}: AddNodeDrawerProps) {
  const { t } = useTranslation();
  const nodeHeadingId = useId();
  const assignmentHeadingId = useId();
  const employeeLabelId = useId();

  const [nodeLocation, setNodeLocation] = useState<RunLocation>("managed");
  const [displayName, setDisplayName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    employeeId?: string;
    workspacePath?: string;
  }>({});
  const [isBusy, setIsBusy] = useState(false);
  const employeeTriggerRef = useRef<HTMLButtonElement>(null);
  const workspacePathRef = useRef<HTMLInputElement>(null);
  const isManaged = nodeLocation === "managed";
  const hasEmployees = employees.length > 0;
  // A cloud computer is provisioned FOR an employee, so with an empty directory
  // that branch has no valid submission at all. Saying so up front beats a
  // disabled picker that reports "Employee ID is required." on every attempt.
  const blockedNoEmployees = isManaged && !hasEmployees;
  const hasUnsavedChanges = Boolean(displayName || employeeId || workspacePath || nodeLocation !== "managed");
  const confirmDiscardChanges = useUnsavedChangesGuard(open && hasUnsavedChanges && !isBusy);

  const selectedEmployee = useMemo(
    () => employees.find((employee) => employee.id === employeeId) ?? null,
    [employees, employeeId],
  );
  // Local computers are the bounded kind. Showing the employee's standing before
  // submit turns a limit rejection from a raw backend string into something the
  // admin could see coming.
  const localQuota =
    !isManaged
    && selectedEmployee
    && selectedEmployee.effectiveMaxLocalComputers !== undefined
    && selectedEmployee.localComputerCount !== undefined
      ? {
          used: selectedEmployee.localComputerCount,
          limit: selectedEmployee.effectiveMaxLocalComputers,
        }
      : null;

  // Reset on open, not on close: clearing as the drawer is dismissed wipes the
  // fields while they are still on screen. Matches ConnectComputerDrawer.
  useOnOpen(open, () => {
    setNodeLocation("managed");
    setDisplayName("");
    setWorkspacePath("");
    setEmployeeId("");
    setError(null);
    setFieldErrors({});
    setIsBusy(false);
  });

  function clearFieldError(field: "employeeId" | "workspacePath") {
    setFieldErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blockedNoEmployees) return;

    const nextFieldErrors: typeof fieldErrors = {};
    if (isManaged && !employeeId) nextFieldErrors.employeeId = t("admin.employee_required");
    if (!isManaged && !workspacePath.trim()) nextFieldErrors.workspacePath = t("admin.v2.workspace_path_required");
    setFieldErrors(nextFieldErrors);
    const firstInvalid = nextFieldErrors.employeeId
      ? employeeTriggerRef
      : nextFieldErrors.workspacePath
        ? workspacePathRef
        : null;
    if (firstInvalid) {
      firstInvalid.current?.focus();
      return;
    }

    setIsBusy(true);
    setError(null);
    try {
      if (isManaged) {
        const result = await createManagedNode({
          employeeId,
          displayName: displayName.trim() || undefined,
          sandboxMode: "boxlite",
        });
        onSuccess({ kind: "managed", result });
      } else {
        // Direct-run, not isolated: this is someone's own machine, and the
        // start command it produces has to match the runtime it can actually
        // boot. Same rule the self-service enrollment route enforces.
        const result = await createControlPanelDaemonNode({
          employeeId: employeeId || undefined,
          displayName: displayName.trim() || undefined,
          workspacePath: workspacePath.trim(),
          sandboxMode: "none",
          nodeLocation: "employee-device",
        });
        onSuccess({ kind: "manual", result });
      }
    } catch (err) {
      setError(t("admin.v2.create_node_error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsBusy(false);
    }
  }

  async function requestClose() {
    if (isBusy) return;
    if (await confirmDiscardChanges()) onClose();
  }

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      kicker={t("admin.v2.provision_kicker_node")}
      title={t("admin.v2.add_node_title")}
      subtitle={t(isManaged ? "admin.v2.add_node_sub_managed" : "admin.v2.add_node_sub_local")}
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
      width="form"
    >
      <form className="adm-form adm-provision-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        {/* The section covers the whole computer, not just its run mode — the
            heading said "Run mode" and so did the radiogroup inside it, which
            read back as the same label twice. */}
        <section className="adm-provision-section" aria-labelledby={nodeHeadingId}>
          <header className="adm-provision-section-head">
            <h3 id={nodeHeadingId} className="adm-provision-section-title">
              {t("admin.v2.section_node")}
            </h3>
          </header>
          <Field
            label={t("admin.v2.computer_name")}
            optional={t("admin.v2.optional")}
            hint={t("admin.v2.computer_name_hint")}
          >
            <Input
              name="add-node-display-name"
              autoComplete="off"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={t(isManaged ? "admin.v2.computer_name_placeholder_managed" : "admin.v2.computer_name_placeholder_local")}
              maxLength={64}
              disabled={isBusy}
            />
          </Field>
          <RunModeField
            value={nodeLocation}
            onChange={(location) => {
              setNodeLocation(location);
              setError(null);
            }}
            name="add-node-location"
            disabled={isBusy}
          />
          {!isManaged ? (
            <Field
              label={t("nav.workspace_label")}
              hint={t("admin.v2.workspace_path_hint")}
              error={fieldErrors.workspacePath}
              errorId="add-node-workspace-path-error"
            >
              <Input
                ref={workspacePathRef}
                data-modal-initial-focus
                name="add-node-workspace-path"
                autoComplete="off"
                spellCheck={false}
                value={workspacePath}
                onChange={(event) => {
                  setWorkspacePath(event.target.value);
                  clearFieldError("workspacePath");
                }}
                placeholder="/Users/alice/project"
                disabled={isBusy}
                aria-invalid={Boolean(fieldErrors.workspacePath) || undefined}
                aria-describedby={fieldErrors.workspacePath ? "add-node-workspace-path-error" : undefined}
              />
            </Field>
          ) : null}
          <aside
            className={`adm-provision-outcome ${isManaged ? "is-managed" : "is-local"}`}
            aria-live="polite"
          >
            <span className="adm-provision-outcome-label">
              {t(isManaged ? "admin.v2.node_ownership_managed" : "admin.v2.node_ownership_local")}
            </span>
            <p className="adm-provision-outcome-body">
              {t(isManaged ? "admin.v2.add_node_outcome_managed" : "admin.v2.add_node_outcome_local")}
            </p>
          </aside>
        </section>

        <section className="adm-provision-section" aria-labelledby={assignmentHeadingId}>
          <header className="adm-provision-section-head">
            <h3 id={assignmentHeadingId} className="adm-provision-section-title">
              {t("admin.v2.section_assignment")}
            </h3>
            <span className="adm-provision-section-meta">
              {t(isManaged ? "admin.v2.required" : "admin.v2.optional")}
            </span>
          </header>

          {hasEmployees ? (
            <Field
              label={t("admin.employee")}
              labelId={employeeLabelId}
              wrapper="div"
              error={fieldErrors.employeeId}
              errorId="add-node-employee-error"
            >
              <Select
                value={employeeId || null}
                onValueChange={(value) => {
                  setEmployeeId(value ?? "");
                  clearFieldError("employeeId");
                }}
              >
                <SelectTrigger
                  ref={employeeTriggerRef}
                  {...(isManaged ? { "data-modal-initial-focus": true } : {})}
                  className="w-full code"
                  aria-labelledby={employeeLabelId}
                  aria-invalid={Boolean(fieldErrors.employeeId) || undefined}
                  aria-describedby={fieldErrors.employeeId ? "add-node-employee-error" : undefined}
                >
                  <SelectValue placeholder={t("admin.select_employee")}>
                    {(value: string | null) => {
                      if (!value) return t("admin.select_employee");
                      const employee = employees.find((e) => e.id === value);
                      if (!employee) return `@${value}`;
                      const handle = employeeHandleOf(employee);
                      return employee.displayName && employee.displayName !== handle
                        ? `${employee.displayName} / @${handle}`
                        : `@${handle}`;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {employees.map((employee) => (
                    <SelectItem key={employee.id} value={employee.id}>
                      {employee.displayName && employee.displayName !== employeeHandleOf(employee)
                        ? `${employee.displayName} / `
                        : ""}
                      <span className="text-muted-foreground">@{employeeHandleOf(employee)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <p className="adm-form-hint adm-form-hint--notice">{t("admin.v2.add_node_no_employees")}</p>
          )}

          {/* Guidance, not a pre-emptive error: this used to render the
              "Employee ID is required." error string as a resting hint, so the
              same sentence appeared twice — muted here and red below — once
              validation ran. */}
          {!selectedEmployee && hasEmployees && !fieldErrors.employeeId ? (
            <p className="adm-form-hint">
              {t(isManaged ? "admin.v2.add_node_assign_managed" : "admin.v2.add_node_assign_later")}
            </p>
          ) : null}

          {localQuota ? (
            <p className="adm-form-hint">
              {t("admin.v2.add_node_local_quota", { used: localQuota.used, limit: localQuota.limit })}
            </p>
          ) : null}
        </section>

        {error ? <Alert variant="boxed" render={<div />}>{error}</Alert> : null}

        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={() => void requestClose()} disabled={isBusy}>
            {t("admin.v2.cancel")}
          </Button>
          <Button size="cta" type="submit" loading={isBusy} disabled={isBusy || blockedNoEmployees}>
            {isBusy
              ? t(isManaged ? "admin.creating" : "admin.v2.generating")
              : t(isManaged ? "admin.v2.provision_node" : "admin.v2.generate_node")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
