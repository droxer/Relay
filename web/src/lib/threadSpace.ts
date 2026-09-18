import type { AgentName, AgentRun, RelayArtifact } from "relay-core";

/** One row of the thread space panel: the artifact plus its derived
 *  producing-agent label (null when the artifact carries no run attribution). */
export type SpaceItem = {
  artifact: RelayArtifact;
  producerLabel: string | null;
};

export const SPACE_WIDTH_DEFAULT = 384;
export const SPACE_WIDTH_MIN = 288;
export const SPACE_WIDTH_MAX = 720;
/** The share of the viewport this column's preferred width is capped to —
 *  the `Nvw` half of `--space-w-fit` in tokens/palette.css, which is what the
 *  shell grid actually asks for. CSS caps the RENDERED width; this constant is
 *  how the drag ceiling agrees with it, so the handle cannot run past a rail
 *  that is not following. shellColumns.test.ts fails if either side moves
 *  alone, exactly as it does for the floors. */
export const SPACE_VIEWPORT_SHARE = 0.30;

/** The drag ceiling's viewport half, shared by all three resizable columns:
 *  `absoluteMax` until the viewport is narrow enough that the shell grid caps
 *  the column at `share` of it instead. Null/unmeasurable viewport keeps the
 *  absolute maximum, which is what every caller did before the caps existed. */
export function viewportCeiling(absoluteMax: number, share: number, viewportWidth: number | null): number {
  if (viewportWidth === null || !Number.isFinite(viewportWidth)) return absoluteMax;
  return Math.min(absoluteMax, Math.round(share * viewportWidth));
}

/** The transcript column never yields below this. The shell grid gives the
 *  chat column `minmax(0, 1fr)`, so without this floor a wide panel plus a
 *  re-opened thread rail can squeeze the conversation to a few pixels. */
export const TRANSCRIPT_MIN_WIDTH = 420;

/** How wide the panel may grow right now: whatever the transcript can give up
 *  before hitting its floor, capped by the absolute maximum. `transcriptWidth`
 *  is the chat column's measured width at the same moment `currentWidth` was
 *  the panel's — measure both once at the start of a gesture so the ceiling
 *  doesn't drift as the grid re-lays out mid-drag. Null (nothing measurable,
 *  e.g. off-DOM) falls back to the absolute maximum. `viewportWidth` caps the
 *  result at the share the shell grid will render (see viewportCeiling). */
export function maxSpaceWidth(
  currentWidth: number,
  transcriptWidth: number | null,
  viewportWidth: number | null = null,
): number {
  const ceiling = viewportCeiling(SPACE_WIDTH_MAX, SPACE_VIEWPORT_SHARE, viewportWidth);
  if (transcriptWidth === null || !Number.isFinite(transcriptWidth)) return Math.max(SPACE_WIDTH_MIN, ceiling);
  const room = currentWidth + (transcriptWidth - TRANSCRIPT_MIN_WIDTH);
  return Math.max(SPACE_WIDTH_MIN, Math.min(ceiling, Math.round(room)));
}

export function clampSpaceWidth(width: number, max: number = SPACE_WIDTH_MAX): number {
  if (typeof width !== "number" || Number.isNaN(width)) return SPACE_WIDTH_DEFAULT;
  const ceiling = Math.min(SPACE_WIDTH_MAX, Math.max(SPACE_WIDTH_MIN, max));
  return Math.min(ceiling, Math.max(SPACE_WIDTH_MIN, Math.round(width)));
}

function fallbackExecutorLabel(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

/** Same resolution as labelForAgentRun in ./agentDisplayNames: the run's
 *  logical agent id wins; the per-executor map is the fallback for legacy
 *  runs and dispatches with no logical identity. Duplicated here because this
 *  file is compiled by both the NodeNext test build (explicit extensions)
 *  and the Next bundle (extensionless runtime imports) — a runtime import
 *  between the two lib files satisfies only one of them. Parity is covered
 *  by web/tests/threadSpace.test.ts. */
function producerLabelForRun(
  run: AgentRun,
  logicalAgentNames?: Record<string, string>,
  agentDisplayNames?: Partial<Record<AgentName, string>>,
): string {
  const named = run.logicalAgentId ? logicalAgentNames?.[run.logicalAgentId] : undefined;
  return named ?? agentDisplayNames?.[run.agent] ?? fallbackExecutorLabel(run.agent);
}

/** Map a thread's visible artifacts to panel rows: newest first, with the
 *  producing agent resolved through the run's logical agent id. Legacy runs
 *  carry no logicalAgentId and fall back to the per-executor display name. */
export function buildSpaceItems(
  artifacts: readonly RelayArtifact[],
  agentRuns: readonly AgentRun[] | undefined,
  logicalAgentNames?: Record<string, string>,
  agentDisplayNames?: Partial<Record<AgentName, string>>,
): SpaceItem[] {
  const runsById = new Map((agentRuns ?? []).map((run) => [run.id, run]));
  return artifacts
    .slice()
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "") || b.id.localeCompare(a.id))
    .map((artifact) => {
      const run = artifact.agentRunId ? runsById.get(artifact.agentRunId) : undefined;
      if (!run) return { artifact, producerLabel: null };
      return {
        artifact,
        producerLabel: producerLabelForRun(run, logicalAgentNames, agentDisplayNames),
      };
    });
}

/** The producer column only earns its space when the thread has more than one
 *  logical agent behind its runs. Runs without a logical identity count by
 *  executor kind, the same fallback attribution uses. */
export function threadHasMultipleProducers(agentRuns: readonly AgentRun[] | undefined): boolean {
  const identities = new Set<string>();
  for (const run of agentRuns ?? []) identities.add(run.logicalAgentId ?? run.agent);
  return identities.size > 1;
}

export function isThreadSpaceEmpty(items: readonly SpaceItem[]): boolean {
  return items.length === 0;
}

/** A selected id that no longer matches an item (the session replaced the
 *  artifact) resolves to null, so the panel falls back to the list level. */
export function resolveSelectedSpaceItem(
  items: readonly SpaceItem[],
  selectedId: string | null,
): SpaceItem | null {
  if (!selectedId) return null;
  return items.find((item) => item.artifact.id === selectedId) ?? null;
}

/** Which half of the panel is on screen: the project's shared workspace files
 *  or the files this thread itself produced. */
export type SpaceTab = "project" | "thread";

/** A thread inside a project opens on the workspace — the files are the shared
 *  record everyone in the project works against, while a single thread's files
 *  are one contribution to it. A thread with no project has no project tab. */
export function defaultSpaceTab(projectId: string | null | undefined): SpaceTab {
  return projectId ? "project" : "thread";
}

/** The tab actually rendered. Two facts outrank the user's last click: a thread
 *  with no project has nothing to show under Project, and a selected file is
 *  this thread's by definition (it is reachable from the transcript, which can
 *  select one while the panel sits on Project). */
export function resolveSpaceTab(
  tab: SpaceTab,
  projectId: string | null | undefined,
  hasSelectedArtifact: boolean,
): SpaceTab {
  if (!projectId) return "thread";
  if (hasSelectedArtifact) return "thread";
  return tab;
}
