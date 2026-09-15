import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonNodeMonitorRecord } from "../../types";
import { nodeOwnershipProfile } from "../../lib/adminHelpers";
import {
  ICON,
  nodeOwnershipIcon,
} from "../icons";
import { ComposerContextLine } from "./ComposerContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";

function runtimeLabel(node: DaemonNodeMonitorRecord): string {
  const displayName = "displayName" in node && typeof node.displayName === "string"
    ? node.displayName.trim()
    : "";
  return displayName || node.id;
}

/**
 * The computer an already-started thread runs on.
 *
 * A thread is pinned to its computer the moment it starts, so this is a
 * readout, not a control — but it has to stay on screen, because "which
 * machine is my work happening on" is exactly as relevant mid-thread as it was
 * at the start. Unlike the picker (whose options are pre-filtered to live
 * computers) this can point at a machine that has since gone offline, so it
 * carries a liveness dot the picker deliberately omits.
 *
 * Context, not a control: it wears the shared `ComposerContextLine` — a
 * lead-in word and the value, no plate, no divider, no chevron — the same
 * shape the project room uses. The agent is the choice; the computer is a fact
 * the thread was born with.
 */
export function ThreadRuntimeReadout({ node, nodeId }: {
  node: DaemonNodeMonitorRecord | null;
  /**
   * The computer the thread is pinned to, even when the fleet no longer lists
   * it. A retired or scoped-out machine used to resolve to `null` and take the
   * whole line with it, so the rail went quiet about where the thread runs —
   * while the picker, facing the same gap, says "no computer available" out
   * loud. The fact survives its record: the id is named, offline.
   */
  nodeId?: string | null;
}) {
  const { t } = useTranslation();
  if (!node) {
    if (!nodeId) return null;
    return (
      <ComposerContextLine
        label={t("thread.runs_on")}
        mark={<span className="adm-presence" data-online="false" aria-hidden="true" />}
        name={nodeId}
        online={false}
        title={`${nodeId} · ${t("thread.runtime_unknown")} — ${t("thread.runtime_pinned")}`}
        srDetail={`${t("thread.runtime_unknown")} · ${t("thread.runtime_pinned")}`}
      />
    );
  }
  const ownership = nodeOwnershipProfile(node);
  const online = Boolean(node.online) && !node.stale;
  const name = runtimeLabel(node);
  const ownershipLabel = t(`admin.v2.node_ownership_${ownership}`);
  const presenceLabel = online ? t("nodes.presence_online") : t("nodes.presence_offline");
  // Ownership and presence stay in the tooltip and the sr-only line; the
  // tooltip also says the pin out loud.
  return (
    <ComposerContextLine
      label={t("thread.runs_on")}
      mark={<span className="adm-presence" data-online={online ? "true" : "false"} aria-hidden="true" />}
      name={name}
      online={online}
      title={`${name} · ${ownershipLabel} · ${presenceLabel} — ${t("thread.runtime_pinned")}`}
      srDetail={`${ownershipLabel} · ${presenceLabel} · ${t("thread.runtime_pinned")}`}
    />
  );
}

/**
 * Where a new thread will run.
 *
 * Every option is already a live computer — `selectableThreadComputers` filters
 * to online, non-stale, ready/running nodes — so the rows carry no status cue.
 * What actually differs between two live machines is whose they are, so each
 * row leads with the ownership mark (cloud / laptop). The node id sits on a
 * second line: it only disambiguates two computers with the same display
 * name, and on the first line it fought the name for width the popup does not
 * have (it used to clip mid-word).
 */
export const ThreadRuntimeSelect = memo(function ThreadRuntimeSelect({
  nodes,
  value,
  selectedNode,
  onValueChange,
}: {
  nodes: DaemonNodeMonitorRecord[];
  value: string | null;
  /**
   * The picked computer resolved against the whole fleet, not just `nodes`.
   * Selectability is a live property — a daemon whose heartbeat lands late
   * drops out of `nodes` for a poll or two — and resolving the label from the
   * filtered list made the trigger flip to "No computer available" and back
   * every few seconds while the pick itself never actually changed.
   */
  selectedNode: DaemonNodeMonitorRecord | null;
  onValueChange: (nodeId: string) => void;
}) {
  const { t } = useTranslation();
  const selected = nodes.find((node) => node.id === value) ?? selectedNode ?? undefined;
  const selectedOwnership = selected ? nodeOwnershipProfile(selected) : null;
  const SelectedMark = selectedOwnership ? nodeOwnershipIcon(selectedOwnership) : null;
  // Holding the pick through a heartbeat flap is right; hiding that the
  // machine is gone is not. When the pick is not among the selectable options
  // the trigger says so — the rows stay cue-free because they are all live.
  const selectedUnavailable = Boolean(selected) && !nodes.some((node) => node.id === selected?.id);
  const selectedTitle = selected
    ? [
      runtimeLabel(selected),
      t(`admin.v2.node_ownership_${selectedOwnership}`),
      ...(selectedUnavailable ? [t("nodes.presence_offline")] : []),
    ].join(" · ")
    : undefined;
  return (
    <div className="thread-runtime-rail" aria-label={t("thread.runtime_label")}>
      <span className="composer-context-label">{t("thread.runs_on")}</span>
      <Select value={selected?.id ?? null} onValueChange={(nodeId) => {
        if (nodeId) onValueChange(nodeId);
      }}>
        <SelectTrigger
          size="sm"
          className="thread-runtime-select"
          data-ownership={selectedOwnership ?? undefined}
          data-online={selected ? (selectedUnavailable ? "false" : "true") : undefined}
          disabled={nodes.length === 0}
          aria-label={t("thread.choose_computer")}
          title={selectedTitle}
        >
          {/* --icon-sm, matching the readout that replaces this trigger once the
              thread starts (ThreadRuntimeReadout draws its mark at ICON.sm) and
              the compact tier the rail sits at. */}
          {SelectedMark ? <SelectedMark size={ICON.sm} aria-hidden="true" /> : null}
          <span className="thread-runtime-select-name">
            {selected ? runtimeLabel(selected) : t("thread.no_computers")}
          </span>
          {selectedUnavailable ? (
            <span className="sr-only">{t("nodes.presence_offline")}</span>
          ) : null}
        </SelectTrigger>
        <SelectContent
          align="start"
          alignItemWithTrigger={false}
          side="top"
          className="thread-runtime-content"
        >
          {nodes.map((node) => {
            const ownership = nodeOwnershipProfile(node);
            const OwnershipMark = nodeOwnershipIcon(ownership);
            const name = runtimeLabel(node);
            return (
              <SelectItem
                key={node.id}
                value={node.id}
                label={name}
                className="thread-runtime-option"
                data-ownership={ownership}
              >
                <OwnershipMark size={ICON.md} aria-hidden="true" />
                <span className="thread-runtime-option-body">
                  <span className="thread-runtime-option-name" translate="no">{name}</span>
                  {name === node.id ? null : (
                    <span className="thread-runtime-option-meta">
                      <span className="thread-runtime-option-id code" translate="no">{node.id}</span>
                    </span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
});
