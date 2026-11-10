import { useTranslation } from "react-i18next";
import type { RoutineListState } from "../lib/routine";
import { RoutineStateIcon } from "./RoutineStateIcon";
import { Badge } from "@/components/ui/badge";

/**
 * Schedule health for a routine, in the shared status-pill grammar so
 * "where does this stand?" reads identically on both boards.
 *
 * The same symbols and semantic colours appear in filters, rows and details.
 *
 * `scheduled` renders NOTHING on a scanning surface. It is the resting state
 * of a healthy routine — the next-run date beside it already says when, and
 * in its neutral tone — so a pill repeating it turned every quiet row into
 * another object to read past. Due, running, listening, on demand and paused
 * each say something the date cannot, and keep their pill. Pass `always` in
 * the drawer, where the record is being inspected rather than scanned.
 */
export function RoutineStateBadge({ state, always = false }: { state: RoutineListState; always?: boolean }) {
  const { t } = useTranslation();
  if (state === "scheduled" && !always) return null;
  /* The shared Badge chrome — `.routine-state` used to restate the same
     padding, hairline, radius, and label type the primitive already owns, and
     only ever needed the per-state accent it keeps below. `variant="state"`
     is the chrome without an opinion about colour. */
  return (
    <Badge variant="state" className="routine-state" data-state={state}>
      <RoutineStateIcon state={state} />
      {t(`routine.states.${state}`)}
    </Badge>
  );
}
