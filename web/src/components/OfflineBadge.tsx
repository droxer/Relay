import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ICON, NodeOffline } from "./icons";

/** Shared absence indicator; connection loss is distinct from a failed run. */
export function OfflineBadge({ className, title }: { className?: string; title?: string }) {
  const { t } = useTranslation();
  return (
    <Badge className={cn("offline-badge", className)} title={title}>
      <NodeOffline size={ICON.xs} aria-hidden="true" />
      <span>{t("status.offline")}</span>
    </Badge>
  );
}
