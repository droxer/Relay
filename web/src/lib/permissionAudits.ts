import { toolTarget } from "./agent-stream/builders.ts";
import type { AgentSegment } from "./agent-stream/segments.ts";
import type { PermissionAudit } from "./projectMessages.ts";

export type PlacedPermissionAudits = {
  /** The audit each tool or command line carries, by segment key. */
  bySegment: ReadonlyMap<string, PermissionAudit>;
  /** Audits no line of the turn matched; they render as their own lines. */
  unplaced: PermissionAudit[];
};

const NONE: PlacedPermissionAudits = { bySegment: new Map(), unplaced: [] };

function segmentTarget(segment: AgentSegment): string | undefined {
  if (segment.kind === "tool") return segment.target;
  if (segment.kind === "command") return toolTarget({ command: segment.command });
  return undefined;
}

function covers(audit: PermissionAudit, segment: AgentSegment): boolean {
  if (segment.kind !== "tool" && segment.kind !== "command") return false;
  if (audit.toolUseId && segment.id) {
    if (audit.toolUseId === segment.id) return true;
    // Codex app-server output renames native call ids to item_N; permission
    // events retain the native id. Historical transcripts need target matching
    // for those command rows, while native tool ids stay authoritative.
    if (segment.kind !== "command" || !/^item_\d+$/.test(segment.id)) return false;
  }
  if (!audit.target) return segment.kind === "tool" && segment.name === audit.toolName && !segment.target;
  if (segment.kind === "tool" && segment.name !== audit.toolName) return false;
  return segmentTarget(segment) === audit.target;
}

/**
 * Place each permission audit on the tool line it covered, so a turn reads
 * "Bash git fetch … · Allowed" instead of the log and a second list of
 * approvals below it. Audits and lines pair in order: the first unclaimed line
 * a prompt covers is the one it answered.
 */
export function placePermissionAudits(
  segments: readonly AgentSegment[],
  keys: readonly string[],
  audits: readonly PermissionAudit[] | undefined,
): PlacedPermissionAudits {
  if (!audits?.length) return NONE;
  const bySegment = new Map<string, PermissionAudit>();
  const unplaced: PermissionAudit[] = [];
  for (const audit of audits) {
    // Search exact ids first so an earlier text match cannot steal the audit.
    const exact = audit.toolUseId ? segments.findIndex((segment, at) =>
      !bySegment.has(keys[at]!) && "id" in segment && segment.id === audit.toolUseId,
    ) : -1;
    const index = exact >= 0 ? exact : segments.findIndex((segment, at) => !bySegment.has(keys[at]!) && covers(audit, segment));
    if (index < 0) unplaced.push(audit);
    else bySegment.set(keys[index]!, audit);
  }
  return { bySegment, unplaced };
}
