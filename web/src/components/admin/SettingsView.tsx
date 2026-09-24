"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getOrgSettings, reissueAdminToken, updateOrgSettings } from "../../api";
import {
  CheckIcon,
  ICON,
} from "../icons";
import { CredCopyRow } from "./CredCopyRow";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { useDialogs } from "@/components/ui/DialogProvider";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import {
  MAX_LOCAL_COMPUTERS_CEILING,
  MAX_TASK_ROUNDS_CEILING,
  MIN_LOCAL_COMPUTERS,
  MIN_TASK_ROUNDS,
} from "../../lib/computerLimits";
import { Alert } from "@/components/ui/alert";

/** Org-wide defaults: how many personal computers an employee may enroll, and
    how many extra rounds a task may run when it keeps reporting itself
    unfinished. Each is a default every employee or task follows unless an admin
    pins a different value on one individually. */
export function SettingsView() {
  const { t } = useTranslation();
  const settingsQuery = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: ({ signal }) => getOrgSettings(signal),
  });
  const settings = settingsQuery.data?.settings;
  const loadError = settingsQuery.error
    ? settingsQuery.error instanceof Error
      ? settingsQuery.error.message
      : String(settingsQuery.error)
    : null;

  return (
    <div className="adm-view adm-settings">
      {loadError ? (
        <Alert>
          {loadError}
        </Alert>
      ) : null}
      <NumberSettingCard
        name="max-local-computers"
        title={t("admin.v2.settings_computers_title")}
        subtitle={t("admin.v2.settings_computers_sub")}
        label={t("admin.v2.settings_limit_label")}
        hint={t("admin.v2.settings_limit_hint", {
          min: MIN_LOCAL_COMPUTERS,
          max: MAX_LOCAL_COMPUTERS_CEILING,
        })}
        min={MIN_LOCAL_COMPUTERS}
        max={MAX_LOCAL_COMPUTERS_CEILING}
        saved={settings?.maxLocalComputersPerEmployee}
        isLoading={settingsQuery.isLoading}
        onSave={async (next) => {
          await updateOrgSettings({ maxLocalComputersPerEmployee: next });
          await settingsQuery.refetch();
        }}
      />
      <NumberSettingCard
        name="max-task-rounds"
        title={t("admin.v2.settings_rounds_title")}
        subtitle={t("admin.v2.settings_rounds_sub")}
        label={t("admin.v2.settings_rounds_label")}
        hint={t("admin.v2.settings_rounds_hint", {
          min: MIN_TASK_ROUNDS,
          max: MAX_TASK_ROUNDS_CEILING,
        })}
        min={MIN_TASK_ROUNDS}
        max={MAX_TASK_ROUNDS_CEILING}
        saved={settings?.maxTaskRounds}
        isLoading={settingsQuery.isLoading}
        onSave={async (next) => {
          await updateOrgSettings({ maxTaskRounds: next });
          await settingsQuery.refetch();
        }}
      />
      <AdminTokenCard
        token={settingsQuery.data?.adminToken ?? null}
        isLoading={settingsQuery.isLoading}
        onReissued={() => void settingsQuery.refetch()}
      />
    </div>
  );
}

/** The admin bearer token for bootstrap and supervisor requests. Seeded from
    RELAY_ADMIN_TOKEN on first boot, generated otherwise, and persisted by the
    backend; reissuing rotates it and kills the old value immediately. */
function AdminTokenCard({
  token,
  isLoading,
  onReissued,
}: {
  token: string | null;
  isLoading: boolean;
  onReissued: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useDialogs();
  const { copiedField, copy } = useCopyFeedback();
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReissue() {
    /* Reissuing kills the current token immediately — the most destructive
       action in settings — so it goes through the themed danger confirm, not
       native window.confirm (same pattern as CredentialsDrawer/EmployeesView). */
    const ok = await confirm({
      title: t("admin.v2.settings_admin_token_reissue"),
      message: t("admin.v2.settings_admin_token_reissue_confirm"),
      confirmLabel: t("admin.v2.settings_admin_token_reissue"),
      tone: "danger",
    });
    if (!ok) return;
    setIsBusy(true);
    setError(null);
    try {
      await reissueAdminToken();
      onReissued();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="adm-settings-item">
      <div className="adm-settings-head">
        <h2 className="adm-settings-title">{t("admin.v2.settings_admin_token_title")}</h2>
        <p className="adm-settings-sub">{t("admin.v2.settings_admin_token_sub")}</p>
      </div>
      {error ? (
        <Alert>
          {error}
        </Alert>
      ) : null}
      {isLoading ? null : token ? (
        <>
          <CredCopyRow
            label={t("admin.v2.settings_admin_token_label")}
            value={token}
            copyLabel={t("admin.v2.settings_admin_token_copy")}
            copied={copiedField === "admin-token"}
            onCopy={() => void copy("admin-token", token)}
          />
          <div className="adm-settings-control">
            <Button
              type="button"
              variant="secondary"
              disabled={isBusy}
              onClick={() => void handleReissue()}
            >
              {isBusy
                ? t("admin.v2.settings_admin_token_reissuing")
                : t("admin.v2.settings_admin_token_reissue")}
            </Button>
          </div>
        </>
      ) : (
        <p className="adm-settings-sub">{t("admin.v2.settings_admin_token_unset")}</p>
      )}
    </div>
  );
}

interface NumberSettingCardProps {
  name: string;
  title: string;
  subtitle: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  saved: number | undefined;
  isLoading: boolean;
  onSave: (value: number) => Promise<void>;
}

/** One org-wide whole-number setting. Each card saves only its own field, so
    two admins editing different settings cannot overwrite each other. */
function NumberSettingCard({
  name,
  title,
  subtitle,
  label,
  hint,
  min,
  max,
  saved,
  isLoading,
  onSave,
}: NumberSettingCardProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  // Seed the field from the server once it answers, and re-seed when a refetch
  // brings a value the user has not edited away from.
  useEffect(() => {
    if (saved === undefined) return;
    setValue(String(saved));
  }, [saved]);

  // The saved confirmation only needs to acknowledge the click — let it fade
  // on its own instead of sitting beside the button indefinitely.
  useEffect(() => {
    if (savedAt === null) return;
    const timer = window.setTimeout(() => setSavedAt(null), 4000);
    return () => window.clearTimeout(timer);
  }, [savedAt]);

  const parsed = Number(value);
  const isValid =
    value.trim() !== ""
    && Number.isInteger(parsed)
    && parsed >= min
    && parsed <= max;
  const isDirty = saved !== undefined && value.trim() !== String(saved);
  const errorId = `admin-settings-${name}-error`;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid) {
      setError(t("admin.v2.settings_limit_invalid", { min, max }));
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      await onSave(parsed);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <form className="adm-settings-item" onSubmit={(event) => void handleSubmit(event)}>
      <div className="adm-settings-head">
        <h2 className="adm-settings-title">{title}</h2>
        <p className="adm-settings-sub">{subtitle}</p>
      </div>

      <Field
        label={label}
        hint={hint}
        error={error ?? undefined}
        errorId={errorId}
        wrapper="div"
        htmlFor={`${name}-input`}
      >
        <div className="adm-settings-control">
          <NumberInput
            id={`${name}-input`}
            name={name}
            className="adm-settings-input"
            min={min}
            max={max}
            value={value}
            disabled={isLoading || isBusy}
            invalid={value !== "" && !isValid}
            describedBy={error ? errorId : undefined}
            onValueChange={(next) => {
              setValue(next);
              setError(null);
              setSavedAt(null);
            }}
          />
          <Button type="submit" disabled={isBusy || !isDirty || !isValid}>
            {isBusy ? t("admin.v2.settings_saving") : t("admin.v2.settings_save")}
          </Button>
          {isDirty && !isBusy ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setValue(saved === undefined ? "" : String(saved));
                setError(null);
                setSavedAt(null);
              }}
            >
              {t("admin.v2.settings_reset")}
            </Button>
          ) : null}
          {savedAt !== null && !isDirty ? (
            <span className="adm-settings-saved" role="status">
              <CheckIcon size={ICON.sm} aria-hidden="true" />
              {t("admin.v2.settings_saved")}
            </span>
          ) : null}
        </div>
      </Field>
    </form>
  );
}
