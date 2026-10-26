import type { DaemonHostOs } from "relay-core";
import type { ControlPanelDaemonNodeRecord } from "../types.ts";

/** Product names, never translated. */
export const HOST_OS_NAMES: Record<DaemonHostOs, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

/** The OS to mark a computer with, or null. A cloud computer's OS is Relay's
    choice rather than a fact about someone's machine, and a daemon older than
    the field reports none — both stay unmarked. */
export function markedHostOs(
  node: Pick<ControlPanelDaemonNodeRecord, "hostOs" | "nodeLocation">,
): DaemonHostOs | null {
  const os = node.hostOs;
  if (!os || !Object.hasOwn(HOST_OS_NAMES, os) || node.nodeLocation === "managed") return null;
  return os;
}
