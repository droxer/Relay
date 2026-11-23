import { useTranslation } from "react-i18next";
import type { DaemonNodeMonitorRecord } from "../types";
import { computerName } from "../lib/computerNodes";
import { StateMark } from "./StateMark";

export function RunStartingCue({ node }: { node: DaemonNodeMonitorRecord | null }) {
  const { t } = useTranslation();
  const computer = node ? computerName(node) : null;
  return (
    <p className="run-starting-cue" role="status">
      <StateMark tone="neutral" shape="dashed" />
      <span>{computer ? t("thread.run_starting_on", { computer }) : t("thread.run_starting")}</span>
    </p>
  );
}
