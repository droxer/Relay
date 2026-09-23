"use client";

import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { MarkLead } from "./icons";

/**
 * The lead mark. Every member of a roster already carries a role pill, a
 * runtime glyph and often a state pill, and "Lead" as a fourth word made the
 * one structural fact on the row — who speaks for the team — the hardest to
 * find. A filled star in the shared badge geometry reads at a glance and
 * costs one glyph of width.
 *
 * It keeps the Badge chrome (info tone, control radius) rather than inventing
 * a second chip shape, and narrows the inline pad because there is no label
 * to sit beside. The name is not dropped, only unspoken: `aria-label` carries
 * it to assistive tech and `title` to a hovering pointer.
 */
export function LeadBadge() {
  const { t } = useTranslation();
  const label = t("project.lead_badge");
  return (
    <Badge variant="info" className="px-1" role="img" aria-label={label} title={label}>
      <MarkLead className="fill-current" aria-hidden="true" />
    </Badge>
  );
}
