/**
 * A skill import is one request that can run for minutes (a GitHub clone and
 * a scan of every bundle in it), and the backend reports nothing until it
 * answers. So the progress shown is honest about what it knows: that work is
 * under way and for how long — never a percentage it would have to invent.
 * The wording steps up as the wait grows so a slow import reads as expected
 * rather than stuck.
 */
export type SkillImportStage = "started" | "slow" | "long";

/** Past this, say large imports take a while. */
export const SKILL_IMPORT_SLOW_MS = 15_000;
/** Past this, ask the person to keep the page open. */
export const SKILL_IMPORT_LONG_MS = 60_000;

export function skillImportStage(elapsedMs: number): SkillImportStage {
  if (elapsedMs >= SKILL_IMPORT_LONG_MS) return "long";
  if (elapsedMs >= SKILL_IMPORT_SLOW_MS) return "slow";
  return "started";
}

/** Elapsed time as m:ss; minutes keep counting past an hour. */
export function formatImportElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
