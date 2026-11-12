import { AGENT_NAMES, type AgentName } from "relay-core";

export type RuntimeLimits = Partial<Record<AgentName, number>>;
export type AdmissionWaitReason = "computer-capacity" | "runtime-capacity";

/** Validate once at startup, before registration can advertise a different limit. */
export function parseRuntimeLimits(raw: string | undefined): RuntimeLimits {
  if (raw === undefined) return {};
  const message = "RELAY_DAEMON_RUNTIME_LIMITS must be a JSON object of runtime names and positive integer limits.";
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(message); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const limits: RuntimeLimits = {};
  for (const [kind, limit] of Object.entries(value)) {
    if (!AGENT_NAMES.includes(kind as AgentName) || !Number.isSafeInteger(limit) || (limit as number) <= 0) {
      throw new Error(message);
    }
    limits[kind as AgentName] = limit as number;
  }
  return limits;
}

export function admissionWaitReason(
  activeRuns: Iterable<{ agent: AgentName }>, agent: AgentName,
  computerLimit: number, limits: RuntimeLimits,
): AdmissionWaitReason | undefined {
  const runs = [...activeRuns];
  if (runs.length >= computerLimit) return "computer-capacity";
  if (runs.filter(run => run.agent === agent).length >= (limits[agent] ?? computerLimit)) {
    return "runtime-capacity";
  }
  return undefined;
}

/** Resource budgets fail startup rather than silently advertising a fallback. */
export function resourceLimit(name: string, value: string | number | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
