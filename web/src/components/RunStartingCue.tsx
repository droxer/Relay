import { useTranslation } from "react-i18next";
import type { DaemonNodeMonitorRecord } from "../types";
import { computerName } from "../lib/computerNodes";
import { StateMark } from "./StateMark";

export function RunStartingCue({ node, sendingMessage = false }: { node: DaemonNodeMonitorRecord | null; sendingMessage?: boolean }) {
  const { t } = useTranslation();
  const computer = node ? computerName(node) : null;
  const status = sendingMessage
    ? t("composer.sending")
    : computer ? t("thread.run_starting_on", { computer }) : t("thread.run_starting");
  return (
    <p className="run-starting-cue" role="status">
      <StateMark tone="neutral" shape="dashed" />
      <span>{status}</span>
    </p>
  );
}
