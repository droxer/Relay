"use client";

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { NOTIFICATION_KINDS, type NotificationKind } from "../../api";
import {
  desktopPermission,
  useDesktopNotificationsSetting,
  useNotificationPreferences,
  type DesktopPermission,
} from "../../hooks/useNotifications";

function isKnownKind(kind: string): kind is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(kind);
}

/** One labelled switch row. The label is the switch's accessible name; the
    sentence under it is its description. */
function ToggleRow({
  label,
  description,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className="notif-pref-row">
      <span className="pref-option-copy">
        <span id={labelId} className="pref-option-label">{label}</span>
        <span id={descriptionId} className="pref-option-sub">{description}</span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
      />
    </div>
  );
}

function KindToggles() {
  const { t } = useTranslation();
  const { preferences, isPending, isError, isFetching, retry, isSaving, setKindEnabled } = useNotificationPreferences();
  if (!preferences) {
    return (
      <div>
        <p className="notif-pref-status" role={isError ? "alert" : "status"}>
          {isPending ? t("notifications.prefs_loading") : isError ? t("notifications.prefs_load_failed") : null}
        </p>
        {isError ? (
          <Button type="button" variant="outline" onClick={retry} loading={isFetching}>
            {t("notifications.retry")}
          </Button>
        ) : null}
      </div>
    );
  }
  // A kind a newer server offers but this build cannot name stays as it is.
  const kinds = preferences.kinds.filter(isKnownKind);
  const muted = new Set(preferences.mutedKinds);
  return (
    <div className="pref-option-list">
      {kinds.map((kind) => (
        <ToggleRow
          key={kind}
          label={t(`notifications.kind.${kind}`)}
          description={t(`notifications.kind.${kind}_sub`)}
          checked={!muted.has(kind)}
          disabled={isSaving}
          onCheckedChange={(on) => setKindEnabled(kind, on)}
        />
      ))}
    </div>
  );
}

function desktopStatusKey(permission: DesktopPermission, enabled: boolean): string {
  if (permission === "unsupported") return "notifications.desktop_unsupported";
  if (permission === "denied") return "notifications.desktop_blocked";
  if (enabled && permission === "granted") return "notifications.desktop_on";
  return "notifications.desktop_sub";
}

function DesktopToggle() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useDesktopNotificationsSetting();
  // The browser's answer is read once here and refreshed after asking; it has
  // no change event a page can subscribe to everywhere.
  const [permission, setPermission] = useState<DesktopPermission>(desktopPermission);
  const [asking, setAsking] = useState(false);
  const on = enabled && permission === "granted";

  async function toggle(next: boolean) {
    if (!next) {
      setEnabled(false);
      return;
    }
    if (permission === "granted") {
      setEnabled(true);
      return;
    }
    if (permission !== "default") return;
    setAsking(true);
    try {
      const answer = await window.Notification.requestPermission();
      setPermission(answer);
      setEnabled(answer === "granted");
    } catch (error) {
      console.warn("Notification permission request failed", error);
      setPermission(desktopPermission());
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="pref-option-list">
      <ToggleRow
        label={t("notifications.desktop")}
        description={t(desktopStatusKey(permission, enabled))}
        checked={on}
        disabled={asking || permission === "unsupported" || permission === "denied"}
        onCheckedChange={(next) => void toggle(next)}
      />
    </div>
  );
}

/** Settings → Notifications: which kinds reach the inbox, and whether this
    browser also shows them as desktop notifications. */
export function NotificationsSection() {
  const { t } = useTranslation();
  return (
    <div className="notif-prefs">
      <fieldset className="pref-fieldset">
        <legend className="pref-group-label">{t("notifications.kinds_group")}</legend>
        <KindToggles />
      </fieldset>
      <fieldset className="pref-fieldset">
        <legend className="pref-group-label">{t("notifications.desktop_group")}</legend>
        <DesktopToggle />
      </fieldset>
    </div>
  );
}
