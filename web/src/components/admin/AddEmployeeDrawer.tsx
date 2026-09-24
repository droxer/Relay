"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { createControlPanelEmployee } from "../../api";
import { initialsOf } from "../../lib/adminHelpers";
import type {
  ControlPanelDaemonNodeRecord,
  CreateControlPanelEmployeeResponse,
} from "../../types";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { Input } from "@/components/ui/input";
import {
  MAX_LOCAL_COMPUTERS_CEILING,
  MIN_LOCAL_COMPUTERS,
  parseLimitInput,
} from "../../lib/computerLimits";
import { isValidEmployeeHandle, normalizeEmployeeHandle } from "../../lib/employeeHandle";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem } from "../../lib/passwordPolicy";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";

interface AddEmployeeDrawerProps {
  open: boolean;
  onClose: () => void;
  unassignedNodes: ControlPanelDaemonNodeRecord[];
  /** The org default, shown as the placeholder for an unset limit. */
  defaultMaxLocalComputers?: number;
  /** False when the auth store cannot store a per-employee limit; the field
      is left out entirely rather than offered and then refused. */
  allowLimitOverride?: boolean;
  onSuccess: (result: CreateControlPanelEmployeeResponse) => void;
}

export function AddEmployeeDrawer({
  open,
  onClose,
  unassignedNodes,
  defaultMaxLocalComputers,
  allowLimitOverride = true,
  onSuccess,
}: AddEmployeeDrawerProps) {
  const { t } = useTranslation();
  const nodeLabelId = useId();

  const [employeeId, setEmployeeId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [maxLocalComputers, setMaxLocalComputers] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    employeeId?: string;
    username?: string;
    password?: string;
    maxLocalComputers?: string;
  }>({});
  const [isBusy, setIsBusy] = useState(false);
  const employeeIdRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const limitRef = useRef<HTMLInputElement>(null);
  const hasUnsavedChanges = Boolean(
    employeeId.trim()
    || displayName.trim()
    || email.trim()
    || username.trim()
    || password
    || selectedNodeId
    || maxLocalComputers.trim(),
  );
  const confirmDiscardChanges = useUnsavedChangesGuard(open && hasUnsavedChanges && !isBusy);

  // The preview shows the NORMALIZED handle, so it cannot promise an identity
  // the backend will not create — `@Alice Chen` is not what gets stored.
  const handlePreview = normalizeEmployeeHandle(employeeId);
  const namePreview = displayName.trim();

  useEffect(() => {
    if (open) {
      setEmployeeId("");
      setDisplayName("");
      setEmail("");
      setUsername("");
      setPassword("");
      setSelectedNodeId("");
      setMaxLocalComputers("");
      setError(null);
      setFieldErrors({});
      setIsBusy(false);
    }
  }, [open]);

  function clearFieldError(field: "employeeId" | "username" | "password" | "maxLocalComputers") {
    setFieldErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextEmployeeId = normalizeEmployeeHandle(employeeId);
    const nextFieldErrors: typeof fieldErrors = {};
    if (!nextEmployeeId) nextFieldErrors.employeeId = t("admin.employee_required");
    else if (!isValidEmployeeHandle(nextEmployeeId)) {
      nextFieldErrors.employeeId = t("admin.v2.employee_id_invalid");
    }
    if (!username.trim()) nextFieldErrors.username = t("admin.username_required");
    if (!password) nextFieldErrors.password = t("admin.password_required");
    else {
      // The account's own names are the first guesses anyone makes, so they are
      // refused here as well as server-side. The blocklist check only exists on
      // the backend; its refusal arrives as the form-level error.
      const problem = passwordProblem(password, [
        username,
        nextEmployeeId,
        displayName,
        email,
      ]);
      if (problem) {
        nextFieldErrors.password = t(`admin.v2.password_problem_${problem}`, {
          min: MIN_PASSWORD_LENGTH,
          max: MAX_PASSWORD_LENGTH,
        });
      }
    }
    // An empty limit is not an error — it means "follow the org default".
    const parsedLimit = parseLimitInput(maxLocalComputers);
    if (parsedLimit === undefined) {
      nextFieldErrors.maxLocalComputers = t("admin.v2.settings_limit_invalid", {
        min: MIN_LOCAL_COMPUTERS,
        max: MAX_LOCAL_COMPUTERS_CEILING,
      });
    }
    setFieldErrors(nextFieldErrors);
    // Every invalid field is in the chain, in the order they appear on screen.
    // The limit used to be validated but never focused, so an invalid limit
    // returned early with focus parked on Submit and the message off-screen.
    const firstInvalid = nextFieldErrors.employeeId
      ? employeeIdRef
      : nextFieldErrors.username
        ? usernameRef
        : nextFieldErrors.password
          ? passwordRef
          : nextFieldErrors.maxLocalComputers
            ? limitRef
            : null;
    if (firstInvalid) {
      firstInvalid.current?.focus();
      return;
    }

    setIsBusy(true);
    setError(null);
    try {
      const result = await createControlPanelEmployee({
        employeeId: nextEmployeeId,
        username: username.trim(),
        password,
        nodeId: selectedNodeId || undefined,
        email: email.trim() || undefined,
        displayName: displayName.trim() || undefined,
        ...(parsedLimit !== null ? { maxLocalComputers: parsedLimit } : {}),
      });
      onSuccess(result);
    } catch (err) {
      setError(t("admin.v2.add_employee_error", { message: err instanceof Error ? err.message : String(err) }));
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
      kicker={t("admin.v2.provision_kicker_employee")}
      title={t("admin.v2.add_employee_title")}
      subtitle={t("admin.v2.add_employee_sub")}
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
      width="form"
    >
      <form className="adm-form adm-provision-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <section className="adm-provision-section" aria-labelledby="adm-emp-identity">
          <header className="adm-provision-section-head">
            <h3 id="adm-emp-identity" className="adm-provision-section-title">
              {t("admin.v2.section_identity")}
            </h3>
          </header>

          {/* Not a live region: it mirrors the field being typed into, so
              announcing it re-read the whole block on every keystroke on top of
              the input's own echo. Sighted reinforcement only. */}
          <div className={`adm-provision-preview ${handlePreview ? "is-live" : ""}`} aria-hidden="true">
            <span className="adm-assign-avatar">
              {handlePreview ? initialsOf(handlePreview) : "?"}
            </span>
            <div className="adm-provision-preview-text">
              <span className="adm-provision-preview-handle code" translate="no">
                {handlePreview ? `@${handlePreview}` : t("admin.v2.provision_preview_placeholder")}
              </span>
              <span className="adm-provision-preview-name">
                {namePreview || t("admin.v2.provision_preview_name_hint")}
              </span>
            </div>
          </div>

          <Field
            label={t("admin.employee_id")}
            required
            hint={t("admin.v2.employee_id_hint")}
            error={fieldErrors.employeeId}
            errorId="add-emp-employee-id-error"
          >
            <Input
              ref={employeeIdRef}
              data-modal-initial-focus
              name="employee-id"
              className="code"
              value={employeeId}
              onChange={(event) => {
                setEmployeeId(event.target.value);
                clearFieldError("employeeId");
              }}
              /* Off, not "username": this form creates someone ELSE's account,
                 and the browser would otherwise offer to save the new
                 employee's credentials as the signed-in admin's own. */
              autoComplete="off"
              spellCheck={false}
              placeholder={t("admin.v2.placeholder_employee_id")}
              aria-invalid={Boolean(fieldErrors.employeeId) || undefined}
              aria-describedby={fieldErrors.employeeId ? "add-emp-employee-id-error" : undefined}
            />
          </Field>

          <Field label={t("admin.display_name")} optional={t("admin.v2.optional")}>
            <Input
              name="display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="off"
              placeholder={t("admin.v2.placeholder_display_name")}
            />
          </Field>

          <Field label={t("admin.email")} optional={t("admin.v2.optional")}>
            <Input
              name="email"
              className="code"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("admin.v2.placeholder_email")}
            />
          </Field>
        </section>

        <section className="adm-provision-section" aria-labelledby="adm-emp-credentials">
          <header className="adm-provision-section-head">
            <h3 id="adm-emp-credentials" className="adm-provision-section-title">
              {t("admin.v2.section_credentials")}
            </h3>
          </header>

          <Field
            label={t("admin.username")}
            required
            error={fieldErrors.username}
            errorId="add-emp-username-error"
          >
            <Input
              ref={usernameRef}
              name="username"
              className="code"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                clearFieldError("username");
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("admin.v2.placeholder_username")}
              aria-invalid={Boolean(fieldErrors.username) || undefined}
              aria-describedby={fieldErrors.username ? "add-emp-username-error" : undefined}
            />
          </Field>

          <Field
            label={t("admin.password")}
            required
            hint={t("admin.v2.password_hint", { min: MIN_PASSWORD_LENGTH })}
            error={fieldErrors.password}
            errorId="add-emp-password-error"
          >
            <Input
              ref={passwordRef}
              name="password"
              className="code"
              type="password"
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                clearFieldError("password");
              }}
              autoComplete="off"
              aria-invalid={Boolean(fieldErrors.password) || undefined}
              aria-describedby={fieldErrors.password ? "add-emp-password-error" : undefined}
            />
          </Field>
        </section>

        {/* The computer limit is a quota, not an identity fact — same section
            it lives in when editing the employee later. */}
        {allowLimitOverride ? (
          <section className="adm-provision-section" aria-labelledby="adm-emp-limits">
            <header className="adm-provision-section-head">
              <h3 id="adm-emp-limits" className="adm-provision-section-title">
                {t("admin.v2.section_limits")}
              </h3>
              <span className="adm-provision-section-meta">{t("admin.v2.optional")}</span>
            </header>

            <Field
              label={t("admin.v2.emp_limit_label")}
              hint={t("admin.v2.emp_limit_hint")}
              error={fieldErrors.maxLocalComputers}
              errorId="add-emp-limit-error"
              wrapper="div"
              htmlFor="add-emp-limit-input"
            >
              <NumberInput
                id="add-emp-limit-input"
                inputRef={limitRef}
                name="max-local-computers"
                min={MIN_LOCAL_COMPUTERS}
                max={MAX_LOCAL_COMPUTERS_CEILING}
                value={maxLocalComputers}
                onValueChange={(next) => {
                  setMaxLocalComputers(next);
                  clearFieldError("maxLocalComputers");
                }}
                placeholder={
                  defaultMaxLocalComputers !== undefined
                    ? t("admin.v2.emp_limit_placeholder", { count: defaultMaxLocalComputers })
                    : undefined
                }
                invalid={Boolean(fieldErrors.maxLocalComputers)}
                describedBy={fieldErrors.maxLocalComputers ? "add-emp-limit-error" : undefined}
              />
            </Field>
          </section>
        ) : null}

        <section className="adm-provision-section" aria-labelledby="adm-emp-assignment">
          <header className="adm-provision-section-head">
            <h3 id="adm-emp-assignment" className="adm-provision-section-title">
              {t("admin.v2.section_assignment")}
            </h3>
            <span className="adm-provision-section-meta">{t("admin.v2.optional")}</span>
          </header>

          {unassignedNodes.length === 0 ? (
            <p className="adm-form-hint adm-form-hint--notice">{t("admin.unassigned_hint")}</p>
          ) : (
            <Field label={t("admin.assign_node")} labelId={nodeLabelId} wrapper="div">
              <Select
                value={selectedNodeId || null}
                onValueChange={(value) => setSelectedNodeId(value ?? "")}
              >
                <SelectTrigger className="w-full code" aria-labelledby={nodeLabelId}>
                  <SelectValue placeholder={t("admin.select_node")} />
                </SelectTrigger>
                <SelectContent>
                  {/* Same row grammar as the employee picker in AddNodeDrawer:
                      the name leads, the identifier trails in muted ink. */}
                  {unassignedNodes.map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.displayName && node.displayName !== node.id
                        ? `${node.displayName} / `
                        : ""}
                      <span className="text-muted-foreground">
                        {node.id}
                        {node.workspacePath ? ` · ${node.workspacePath}` : ""}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </section>

        {error ? <Alert variant="boxed" render={<div />}>{error}</Alert> : null}

        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={() => void requestClose()} disabled={isBusy}>
            {t("admin.v2.cancel")}
          </Button>
          <Button size="cta" type="submit" loading={isBusy}>
            {isBusy ? t("admin.creating") : t("admin.v2.provision")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
