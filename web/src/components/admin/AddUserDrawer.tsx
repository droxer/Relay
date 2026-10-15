"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { createControlPanelUser } from "../../api";
import type {
  ControlPanelDaemonNodeRecord,
  CreateControlPanelUserResponse,
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
import { isValidUserHandle, normalizeUserHandle } from "../../lib/userHandle";
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
import { useOnOpen } from "@/hooks/useKeyChange";

interface AddUserDrawerProps {
  open: boolean;
  onClose: () => void;
  unassignedNodes: ControlPanelDaemonNodeRecord[];
  /** The org default, shown as the placeholder for an unset limit. */
  defaultMaxLocalComputers?: number;
  /** False when the auth store cannot store a per-user limit; the field
      is left out entirely rather than offered and then refused. */
  allowLimitOverride?: boolean;
  onSuccess: (result: CreateControlPanelUserResponse) => void;
}

export function AddUserDrawer({
  open,
  onClose,
  unassignedNodes,
  defaultMaxLocalComputers,
  allowLimitOverride = true,
  onSuccess,
}: AddUserDrawerProps) {
  const { t } = useTranslation();
  const nodeLabelId = useId();

  const [userId, setUserId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [maxLocalComputers, setMaxLocalComputers] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    userId?: string;
    username?: string;
    password?: string;
    maxLocalComputers?: string;
  }>({});
  const [isBusy, setIsBusy] = useState(false);
  const userIdRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const limitRef = useRef<HTMLInputElement>(null);
  const hasUnsavedChanges = Boolean(
    userId.trim()
    || displayName.trim()
    || email.trim()
    || username.trim()
    || password
    || selectedNodeId
    || maxLocalComputers.trim(),
  );
  const confirmDiscardChanges = useUnsavedChangesGuard(open && hasUnsavedChanges && !isBusy);

  // When the typed id is not what gets stored (`@Alice` → `alice`), the hint
  // says so — the form never promises an identity the backend will not create.
  const normalizedHandle = normalizeUserHandle(userId);
  const handleIsNormalized = Boolean(normalizedHandle) && normalizedHandle !== userId.trim();

  useOnOpen(open, () => {
    setUserId("");
    setDisplayName("");
    setEmail("");
    setUsername("");
    setPassword("");
    setSelectedNodeId("");
    setMaxLocalComputers("");
    setError(null);
    setFieldErrors({});
    setIsBusy(false);
  });

  function clearFieldError(field: "userId" | "username" | "password" | "maxLocalComputers") {
    setFieldErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextUserId = normalizeUserHandle(userId);
    const nextFieldErrors: typeof fieldErrors = {};
    if (!nextUserId) nextFieldErrors.userId = t("admin.user_required");
    else if (!isValidUserHandle(nextUserId)) {
      nextFieldErrors.userId = t("admin.v2.user_id_invalid");
    }
    if (!username.trim()) nextFieldErrors.username = t("admin.username_required");
    if (!password) nextFieldErrors.password = t("admin.password_required");
    else {
      // The account's own names are the first guesses anyone makes, so they are
      // refused here as well as server-side. The blocklist check only exists on
      // the backend; its refusal arrives as the form-level error.
      const problem = passwordProblem(password, [
        username,
        nextUserId,
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
    const firstInvalid = nextFieldErrors.userId
      ? userIdRef
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
      const result = await createControlPanelUser({
        userId: nextUserId,
        username: username.trim(),
        password,
        nodeId: selectedNodeId || undefined,
        email: email.trim() || undefined,
        displayName: displayName.trim() || undefined,
        ...(parsedLimit !== null ? { maxLocalComputers: parsedLimit } : {}),
      });
      onSuccess(result);
    } catch (err) {
      setError(t("admin.v2.add_user_error", { message: err instanceof Error ? err.message : String(err) }));
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
      kicker={t("admin.v2.provision_kicker_user")}
      title={t("admin.v2.add_user_title")}
      subtitle={t("admin.v2.add_user_sub")}
      closeLabel={t("drawer.close")}
      bodyClassName="adm-drawer-body--column"
      width="form"
    >
      <form className="adm-form adm-provision-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <section className="adm-provision-section" aria-labelledby="adm-emp-identity">
          <h3 id="adm-emp-identity" className="adm-provision-section-title">
            {t("admin.v2.section_identity")}
          </h3>

          <Field
            label={t("admin.user_id")}
            required
            hint={handleIsNormalized
              ? t("admin.v2.user_id_normalized", { handle: normalizedHandle })
              : t("admin.v2.user_id_hint")}
            error={fieldErrors.userId}
            errorId="add-emp-user-id-error"
          >
            <Input
              ref={userIdRef}
              data-modal-initial-focus
              name="user-id"
              className="code"
              value={userId}
              onChange={(event) => {
                setUserId(event.target.value);
                clearFieldError("userId");
              }}
              /* Off, not "username": this form creates someone ELSE's account,
                 and the browser would otherwise offer to save the new
                 user's credentials as the signed-in admin's own. */
              autoComplete="off"
              spellCheck={false}
              placeholder={t("admin.v2.placeholder_user_id")}
              aria-invalid={Boolean(fieldErrors.userId) || undefined}
              aria-describedby={fieldErrors.userId ? "add-emp-user-id-error" : undefined}
            />
          </Field>

          <div className="adm-provision-pair">
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
          </div>
        </section>

        <section className="adm-provision-section" aria-labelledby="adm-emp-credentials">
          <h3 id="adm-emp-credentials" className="adm-provision-section-title">
            {t("admin.v2.section_credentials")}
          </h3>

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

        {/* Everything about the user's machines, and all of it optional:
            a computer to hand over now, and the quota for the ones they
            enroll themselves. One section instead of two half-empty ones. */}
        <section className="adm-provision-section" aria-labelledby="adm-emp-computers">
          <h3 id="adm-emp-computers" className="adm-provision-section-title">
            {t("admin.v2.section_computers")}
            <span className="adm-provision-section-meta">{t("admin.v2.optional")}</span>
          </h3>

          {unassignedNodes.length === 0 ? (
            <Field label={t("admin.assign_node")} wrapper="div" hint={t("admin.unassigned_hint")}>
              {null}
            </Field>
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
                  {/* Same row grammar as the user picker in AddNodeDrawer:
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

          {/* Left out entirely when the auth store cannot keep a per-user
              limit, rather than offered and then refused. */}
          {allowLimitOverride ? (
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
          ) : null}
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
