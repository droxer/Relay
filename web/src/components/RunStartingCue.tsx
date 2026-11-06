import { useTranslation } from "react-i18next";
import type { DaemonNodeMonitorRecord } from "../types";
import { computerName } from "../lib/computerNodes";
import { StateMark } from "./StateMark";

/**
 * A run that has started but printed nothing yet. Without this the thread is
 * an empty canvas under a Stop button, which reads the same as a stall; the
 * line says where the run is and that output lands here as it begins.
 */
export function RunStartingCue({ node }: { node: DaemonNodeMonitorRecord | null }) {
  const { t } = useTranslation();
  const computer = node ? computerName(node) : null;
  return (
    <p className="run-starting-cue" role="status">
      <StateMark tone="live" />
      {computer ? t("thread.run_starting_on", { computer }) : t("thread.run_starting")}
    </p>
  );
}
