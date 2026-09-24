import { useTranslation } from "react-i18next";
import type { RelaySession } from "../types";
import { reviewBudgetExhausted, reviewCycle } from "../lib/collaborationStyle";

export function CollaborationStatus({ session }: { session?: RelaySession | null }) {
  const { t } = useTranslation();
  if (!session) return null;
  const cycle = reviewCycle(session);
  if (cycle) return <p className="collab-status" role="status">{t("collab_style.review_cycle", cycle)}</p>;
  if (reviewBudgetExhausted(session)) return <p className="collab-status" role="status">{t("collab_style.waiting_for_you")}</p>;
  return null;
}
