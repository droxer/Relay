import type { RelayArtifact } from "relay-core";

type ArtifactKind = RelayArtifact["kind"];

type ArtifactStatTone = "good" | "bad" | "neutral";

/** A one-line, kind-aware summary derived from an artifact body. */
interface ArtifactStat {
  /** i18n key under `artifact.stat.*`. */
  key: string;
  /** Interpolation values for the i18n string. */
  vars: Record<string, string | number>;
  /** Semantic color hint for the chip badge. */
  tone: ArtifactStatTone;
}

/** Diff additions/deletions and touched-file count, parsed from unified-diff text. */
function diffStat(text: string): ArtifactStat {
  let additions = 0;
  let deletions = 0;
  const files = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git")) {
      const match = /b\/(\S+)\s*$/.exec(line);
      if (match) files.add(match[1]);
      continue;
    }
    // Skip the +++/--- file headers; count only hunk body lines.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return {
    key: "diff",
    vars: { additions, deletions, count: files.size },
    tone: "neutral",
  };
}

/** Pass/fail tallies from common test-runner summaries. */
function testStat(text: string): ArtifactStat {
  const passed = sumMatches(text, /(\d+)\s+(?:passed|passing|ok)\b/gi);
  const failed = sumMatches(text, /(\d+)\s+(?:failed|failing|errors?)\b/gi);
  if (passed === 0 && failed === 0) {
    return { key: "test_unknown", vars: {}, tone: "neutral" };
  }
  return {
    key: "test",
    vars: { passed, failed },
    tone: failed > 0 ? "bad" : "good",
  };
}

/** Exit code from a command/shell log, when one is recorded. */
function commandStat(text: string): ArtifactStat {
  const match = /(?:exit(?:\s*code)?|returned)\D*(\d+)/i.exec(text);
  if (!match) return { key: "command_unknown", vars: {}, tone: "neutral" };
  const code = Number(match[1]);
  return {
    key: "command",
    vars: { code },
    tone: code === 0 ? "good" : "bad",
  };
}

/**
 * Derive a compact, semantic stat for an artifact from its body text.
 * Returns null for kinds with no meaningful one-line summary (the chip then
 * falls back to byte size). Pure — safe to unit-test in isolation.
 */
export function summarizeArtifact(kind: ArtifactKind, text: string): ArtifactStat | null {
  if (!text.trim()) return null;
  switch (kind) {
    case "diff":
      return diffStat(text);
    case "test_output":
      return testStat(text);
    case "command_log":
      return commandStat(text);
    default:
      return null;
  }
}

function sumMatches(text: string, pattern: RegExp): number {
  let total = 0;
  for (const match of text.matchAll(pattern)) {
    total += Number(match[1]);
  }
  return total;
}
