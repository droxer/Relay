import type { AgentName } from "../../types.ts";
import { sameRenderedText } from "./builders.ts";
import { agentCheckpointId, agentCheckpoints, parseAgentStream } from "./parse.ts";
import type { AgentSegment } from "./segments.ts";
import { CodexStreamParser } from "./codex.ts";
import { OpenCodeStreamParser } from "./opencode.ts";

/**
 * Keeps completed agent turns as parsed checkpoints and reparses only the
 * unfinished suffix while stdout grows. Replacing or truncating stdout resets
 * the cache, so completed-log fallback and run reuse remain correct.
 */
export class AgentStreamAccumulator {
  private raw = "";
  private stableOffset = 0;
  private stableSegments: AgentSegment[] = [];
  private segments: AgentSegment[] = [];
  private seenCheckpointIds = new Set<string>();
  // Text committed by the most recent Claude assistant checkpoint slice. The
  // result frame is checkpointed separately, so its fallback copy of the reply
  // must dedup against these — the slice-local check inside parseClaude cannot
  // see segments committed by an earlier slice.
  private turnTextSignatures = new Set<string>();
  // Set once Claude's `result` frame is seen; from then on the log is parsed
  // canonically as a whole (see update).
  private settled = false;
  private incremental: CodexStreamParser | OpenCodeStreamParser | undefined;

  constructor(private readonly agent: AgentName) {
    this.incremental = this.makeIncrementalParser();
  }

  private makeIncrementalParser() {
    if (this.agent === "codex") return new CodexStreamParser();
    if (this.agent === "opencode") return new OpenCodeStreamParser();
    return undefined;
  }

  update(raw: string): AgentSegment[] {
    if (raw === this.raw) return this.segments;
    if (!raw.startsWith(this.raw)) {
      this.stableOffset = 0;
      this.stableSegments = [];
      this.seenCheckpointIds.clear();
      this.turnTextSignatures.clear();
      this.settled = false;
      this.incremental = this.makeIncrementalParser();
    }
    this.raw = raw;

    // Everything before stableOffset is already checkpointed, so only the
    // suffix can hold a new frame — rescanning the whole log here made each
    // streamed delta cost the length of the run.
    const checkpoints = this.settled ? [] : agentCheckpoints(this.agent, raw, this.stableOffset);

    if (this.incremental) {
      // Commit complete records once and keep the current reply across deltas.
      const checkpoint = checkpoints.at(-1);
      if (checkpoint) {
        this.incremental.append(raw.slice(this.stableOffset, checkpoint.end));
        this.stableOffset = checkpoint.end;
      }
      this.segments = this.incremental.preview(raw.slice(this.stableOffset));
      return this.segments;
    }

    // A completed Claude transcript is small enough to parse canonically once.
    // More importantly, the full parse can reconcile replayed assistant frames
    // with the streamed deltas that preceded them. Keeping checkpoint slices
    // at this boundary can strand a historical U+FFFD-corrupted frame even
    // though another frame in the same raw log contains the intact text.
    if (
      this.agent === "claude"
      && (this.settled || checkpoints.some((checkpoint) => checkpoint.value.type === "result"))
    ) {
      this.settled = true;
      this.stableOffset = 0;
      this.stableSegments = [];
      this.seenCheckpointIds.clear();
      this.turnTextSignatures.clear();
      this.segments = parseAgentStream(this.agent, raw);
      return this.segments;
    }

    let sliceStart = this.stableOffset;
    for (const checkpoint of checkpoints) {
      const checkpointId = agentCheckpointId(this.agent, checkpoint.value);
      if (!checkpointId || !this.seenCheckpointIds.has(checkpointId)) {
        let parsed = parseAgentStream(this.agent, raw.slice(sliceStart, checkpoint.end));
        if (this.agent === "claude") {
          if (checkpoint.value.type === "assistant") {
            this.turnTextSignatures = new Set(
              parsed
                .filter((segment): segment is Extract<AgentSegment, { kind: "text" }> => segment.kind === "text")
                .map((segment) => segment.text.trimEnd()),
            );
          } else if (checkpoint.value.type === "result") {
            if (this.turnTextSignatures.size > 0) {
              parsed = parsed.filter(
                (segment) => segment.kind !== "text" || ![...this.turnTextSignatures]
                  .some((rendered) => sameRenderedText(rendered, segment.text.trimEnd())),
              );
              this.turnTextSignatures.clear();
            }
          }
        }
        this.stableSegments.push(...parsed);
      }
      if (checkpointId) this.seenCheckpointIds.add(checkpointId);
      sliceStart = checkpoint.end;
      this.stableOffset = checkpoint.end;
    }
    this.segments = [
      ...this.stableSegments,
      ...parseAgentStream(this.agent, raw.slice(this.stableOffset)),
    ];
    return this.segments;
  }
}
