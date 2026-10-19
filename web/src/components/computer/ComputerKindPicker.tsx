"use client";

import { useTranslation } from "react-i18next";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { ICON, NodeLocal, NodeManaged } from "../icons";

/**
 * What kind of computer to add. Only the person's own machine is available
 * today; the cloud computer is shown — disabled, marked coming soon — so the
 * drawer already reads as the place both will live.
 */
export function ComputerKindPicker() {
  const { t } = useTranslation();
  return (
    <RadioGroup
      className="computer-kind-picker"
      name="computer-kind"
      aria-label={t("computer.kind_label")}
      value="local"
    >
      <RadioGroupChoice value="local" className="computer-kind">
        <NodeLocal size={ICON.lg} aria-hidden="true" className="computer-kind-icon" />
        <span className="computer-kind-body">
          <span className="computer-kind-title">{t("computer.kind_local")}</span>
          <span className="computer-kind-desc">{t("computer.kind_local_desc")}</span>
        </span>
      </RadioGroupChoice>
      <RadioGroupChoice value="cloud" className="computer-kind" disabled>
        <NodeManaged size={ICON.lg} aria-hidden="true" className="computer-kind-icon" />
        <span className="computer-kind-body">
          <span className="computer-kind-title">
            {t("computer.kind_cloud")}
            <Badge variant="info">{t("nav.coming_soon")}</Badge>
          </span>
          <span className="computer-kind-desc">{t("computer.kind_cloud_desc")}</span>
        </span>
      </RadioGroupChoice>
    </RadioGroup>
  );
}
