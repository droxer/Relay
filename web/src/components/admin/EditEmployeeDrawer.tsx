"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { updateControlPanelEmployee } from "../../api";
import type { EmployeeRecord } from "../../types";
import { employeeHandleOf } from "../../lib/employeeHandle";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import {
  MAX_LOCAL_COMPUTERS_CEILING,
  MIN_LOCAL_COMPUTERS,
  parseLimitInput,
} from "../../lib/computerLimits";
import { Alert } from "@/components/ui/alert";

interface EditEmployeeDrawerProps {
  open: boolean;
  onClose: () => void;
  employee: EmployeeRecord | null;
  /** The org default, shown as the placeholder when no override is pinned. */
  defaultMaxLocalComputers?: number;
  onSuccess: (employee: EmployeeRecord) => void;
}

/** Edit an existing employee: name, email, and their personal-computer limit.

    Leaving the limit field empty clears the override, so the employee follows
    the org default again — that is a real edit, not a no-op, which is why the
    submit sends an explicit `null` rather than omitting the key. */
export function EditEmployeeDrawer({
  open,
  onClose,
  employee,
  defaultMaxLocalComputers,
  onSuccess,
}: EditEmployeeDrawerProps) {
  const { t } = useTranslation();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [maxLocalComputers, setMaxLocalComputers] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const limitRef = useRef<HTMLInputElement>(null);

  const initialDisplayName = employee?.displayName ?? "";
  const initialEmail = employee?.email ?? "";
  const initialLimit =
    employee?.maxLocalComputers != null ? String(employee.maxLocalComputers) : "";

  useEffect(() => {
    if (!open) return;
    setDisplayName(initialDisplayName);
    setEmail(initialEmail);
    setMaxLocalComputers(initialLimit);
    setError(null);
    setNameError(null);
    setLimitError(null);
    setIsBusy(false);
  }, [open, initialDisplayName, initialEmail, initialLimit]);

  const hasUnsavedChanges =
    displayName !== initialDisplayName
    || email !== initialEmail
    || maxLocalComputers !== initialLimit;
  const confirmDiscardChanges = useUnsavedChangesGuard(open && hasUnsavedChanges && !isBusy);

  async function requestClose() {
    if (isBusy) return;
    if (await confirmDiscardChanges()) onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!employee) return;
    // Both failures are field errors, under their own control and focused —
    // the missing name used to surface as a boxed submit-level error at the
    // foot of the form, and the limit error was never focused at all.
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setNameError(t("admin.v2.edit_employee_name_required"));
      displayNameRef.current?.focus();
      return;
    }
    const parsedLimit = parseLimitInput(maxLocalComputers);
    if (parsedLimit === undefined) {
      setLimitError(t("admin.v2.settings_limit_invalid", {
        min: MIN_LOCAL_COMPUTERS,
        max: MAX_LOCAL_COMPUTERS_CEILING,
      }));
      limitRef.current?.focus();
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      const result = await updateControlPanelEmployee({
        employeeId: employee.id,
        displayName: trimmedName,
        email: email.trim(),
        maxLocalComputers: parsedLimit,
      });
      onSuccess(result.employee);
    } catch (err) {
      setError(t("admin.v2.edit_employee_error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      kicker={t("admin.v2.provision_kicker_employee")}
      title={t("admin.v2.edit_employee_title")}
      subtitle={employee ? `@${employeeHandleOf(employee)}` : undefined}
      subtitleMono={Boolean(employee)}
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
      width="form"
    >
      <form className="adm-form adm-provision-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <section className="adm-provision-section" aria-labelledby="adm-edit-emp-identity">
          <header className="adm-provision-section-head">
            <h3 id="adm-edit-emp-identity" className="adm-provision-section-title">
              {t("admin.v2.section_identity")}
            </h3>
          </header>

          <Field
            label={t("admin.display_name")}
            required
            error={nameError ?? undefined}
            errorId="edit-emp-name-error"
          >
            <Input
              ref={displayNameRef}
              data-modal-initial-focus
              name="display-name"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
                setNameError(null);
              }}
              autoComplete="off"
              placeholder={t("admin.v2.placeholder_display_name")}
              aria-invalid={Boolean(nameError) || undefined}
              aria-describedby={nameError ? "edit-emp-name-error" : undefined}
            />
          </Field>

          <Field label={t("admin.email")} optional={t("admin.v2.optional")}>
            <Input
              name="email"
              className="code"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              /* Off: this edits someone ELSE's account, so the admin's own
                 contact autofill has no business here. */
              autoComplete="off"
              spellCheck={false}
              placeholder={t("admin.v2.placeholder_email")}
            />
          </Field>
        </section>

        <section className="adm-provision-section" aria-labelledby="adm-edit-emp-limits">
          <header className="adm-provision-section-head">
            <h3 id="adm-edit-emp-limits" className="adm-provision-section-title">
              {t("admin.v2.section_limits")}
            </h3>
          </header>

          <Field
            label={t("admin.v2.emp_limit_label")}
            optional={t("admin.v2.optional")}
            hint={t("admin.v2.emp_limit_hint")}
            error={limitError ?? undefined}
            errorId="edit-emp-limit-error"
          >
            <Input
              ref={limitRef}
              name="max-local-computers"
              type="number"
              inputMode="numeric"
              min={MIN_LOCAL_COMPUTERS}
              max={MAX_LOCAL_COMPUTERS_CEILING}
              step={1}
              value={maxLocalComputers}
              onChange={(event) => {
                setMaxLocalComputers(event.target.value);
                setLimitError(null);
              }}
              placeholder={
                defaultMaxLocalComputers !== undefined
                  ? t("admin.v2.emp_limit_placeholder", { count: defaultMaxLocalComputers })
                  : undefined
              }
              aria-invalid={Boolean(limitError) || undefined}
              aria-describedby={limitError ? "edit-emp-limit-error" : undefined}
            />
          </Field>

          {maxLocalComputers.trim() ? (
            <Button
              type="button"
              variant="ghost"
              size="dense"
              className="self-start"
              onClick={() => {
                setMaxLocalComputers("");
                setLimitError(null);
              }}
            >
              {t("admin.v2.emp_limit_use_default")}
            </Button>
          ) : null}

          {employee?.localComputerCount !== undefined ? (
            <p className="adm-form-hint">
              {t("admin.v2.emp_limit_in_use", { count: employee.localComputerCount })}
            </p>
          ) : null}
        </section>

        {error ? <Alert variant="boxed" render={<div />}>{error}</Alert> : null}

        <div className="adm-form-actions">
          <Button size="cta" type="button" variant="ghost" onClick={() => void requestClose()} disabled={isBusy}>
            {t("admin.v2.cancel")}
          </Button>
          <Button size="cta" type="submit" loading={isBusy} disabled={isBusy || !hasUnsavedChanges}>
            {t("admin.v2.save")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
