"use client";

import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import { MarkLead } from "./icons";

/** Keep the role explicit; dense rows may opt into a labelled star mark. */
export function LeadBadge({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const label = t("project.lead_badge");
  if (compact) {
    return (
      <Tooltip content={label}>
        <Badge size="compact" variant="info" className="px-1" role="img" aria-label={label} tabIndex={0}>
          <MarkLead className="fill-current" aria-hidden="true" />
        </Badge>
      </Tooltip>
    );
  }
  return (
    <Badge variant="info">
      <MarkLead className="fill-current" aria-hidden="true" />
      {label}
    </Badge>
  );
}
