import { createElement } from "react";
import type { RoutineListState } from "../lib/routine";
import {
  AutomationAll, AutomationRunning, AutomationDue, AutomationScheduled,
  AutomationListening, AutomationOnDemand, AutomationPaused, ICON,
} from "./icons";

const STATE_ICON = {
  all: AutomationAll,
  running: AutomationRunning,
  due: AutomationDue,
  scheduled: AutomationScheduled,
  listening: AutomationListening,
  on_demand: AutomationOnDemand,
  paused: AutomationPaused,
} satisfies Record<RoutineListState | "all", typeof AutomationAll>;

/** Filter symbols stay recognizable even when a section has no records. */
export function RoutineStateIcon({ state, empty = false }: {
  state: RoutineListState | "all";
  empty?: boolean;
}) {
  return (
    <span className="routine-state-icon" data-state={state} data-empty={empty || undefined} aria-hidden="true">
      {createElement(STATE_ICON[state], { size: ICON.md })}
    </span>
  );
}
