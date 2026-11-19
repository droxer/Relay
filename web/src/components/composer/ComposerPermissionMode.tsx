import { useTranslation } from "react-i18next";
import type { ThreadPermissionMode } from "relay-core";
import { ComposerPermissionShield, ICON } from "../icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function ComposerPermissionMode({ mode, pending, onChange }: {
  mode: ThreadPermissionMode;
  pending?: boolean;
  onChange?: (mode: ThreadPermissionMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select value={mode} onValueChange={(value) => { if (value) onChange?.(value); }} disabled={pending || !onChange}>
      <SelectTrigger
        className="composer-permission-mode"
        data-mode={mode}
        aria-label={t("composer.permission_mode")}
        aria-busy={pending || undefined}
      >
        <ComposerPermissionShield size={ICON.sm} aria-hidden="true" />
        <SelectValue>{t(mode === "yolo" ? "composer.permission_yolo" : "composer.permission_ask")}</SelectValue>
      </SelectTrigger>
      <SelectContent side="top" align="start" alignItemWithTrigger={false} className="w-max max-w-(--available-width)">
        <SelectItem value="ask">{t("composer.permission_ask_option")}</SelectItem>
        <SelectItem value="yolo">{t("composer.permission_yolo_option")}</SelectItem>
      </SelectContent>
    </Select>
  );
}
