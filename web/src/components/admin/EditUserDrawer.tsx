"use client";

import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { updateControlPanelUser } from "../../api";
import type { UserRecord } from "../../types";
import { userHandleOf } from "../../lib/userHandle";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { Input } from "@/components/ui/input";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import {
  MAX_LOCAL_COMPUTERS_CEILING,
  MIN_LOCAL_COMPUTERS,
  parseLimitInput,
} from "../../lib/computerLimits";
import { Alert } from "@/components/ui/alert";
import { useOnOpen } from "@/hooks/useKeyChange";
import { UserPasswordReset } from "./UserPasswordReset";

interface EditUserDrawerProps {
  open: boolean;
  onClose: () => void;
  user: UserRecord | null;
  /** The org default, shown as the placeholder when no override is pinned. */
  defaultMaxLocalComputers?: number;
  onSuccess: (user: UserRecord) => void;
}

/** Edit an existing user: name, email, their personal-computer limit, and a
    one-time password reset link (its own action, outside the form's Save).

    Leaving the limit field empty clears the override, so the user follows
    the org default again — that is a real edit, not a no-op, which is why the
    submit sends an explicit `null` rather than omitting the key. */
export function EditUserDrawer({
  open,
  onClose,
  user,
  defaultMaxLocalComputers,
  onSuccess,
}: EditUserDrawerProps) {
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

  const initialDisplayName = user?.displayName ?? "";
  const initialEmail = user?.email ?? "";
  const initialLimit =
    user?.maxLocalComputers != null ? String(user.maxLocalComputers) : "";

  useOnOpen(open, () => {
    setDisplayName(initialDisplayName);
    setEmail(initialEmail);
    setMaxLocalComputers(initialLimit);
    setError(null);
    setNameError(null);
    setLimitError(null);
    setIsBusy(false);
  }, `${initialDisplayName}\u0000${initialEmail}\u0000${initialLimit}`);

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
    if (!user) return;
    // Both failures are field errors, under their own control and focused —
    // the missing name used to surface as a boxed submit-level error at the
    // foot of the form, and the limit error was never focused at all.
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setNameError(t("admin.v2.edit_user_name_required"));
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
      const result = await updateControlPanelUser({
        userId: user.id,
        displayName: trimmedName,
        email: email.trim(),
        maxLocalComputers: parsedLimit,
      });
      onSuccess(result.user);
    } catch (err) {
      setError(t("admin.v2.edit_user_error", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => { void requestClose(); }}
      kicker={t("admin.v2.provision_kicker_user")}
      title={t("admin.v2.edit_user_title")}
      subtitle={user ? `@${userHandleOf(user)}` : undefined}
      subtitleMono={Boolean(user)}
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
            wrapper="div"
            htmlFor="edit-emp-limit-input"
          >
            <NumberInput
              id="edit-emp-limit-input"
              inputRef={limitRef}
              name="max-local-computers"
              min={MIN_LOCAL_COMPUTERS}
              max={MAX_LOCAL_COMPUTERS_CEILING}
              value={maxLocalComputers}
              onValueChange={(next) => {
                setMaxLocalComputers(next);
                setLimitError(null);
              }}
              placeholder={
                defaultMaxLocalComputers !== undefined
                  ? t("admin.v2.emp_limit_placeholder", { count: defaultMaxLocalComputers })
                  : undefined
              }
              invalid={Boolean(limitError)}
              describedBy={limitError ? "edit-emp-limit-error" : undefined}
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

          {user?.localComputerCount !== undefined ? (
            <p className="adm-form-hint">
              {t("admin.v2.emp_limit_in_use", { count: user.localComputerCount })}
            </p>
          ) : null}
        </section>

        {user ? <UserPasswordReset open={open} userId={user.id} /> : null}

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
