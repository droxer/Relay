/* Agent CLI stream parsing and display, split under `agent-stream/`:
   `records` frames the raw log, `claude`/`codex`/`pi`/`kimi`/`opencode` parse each CLI's
   events into segments, `accumulator` reparses only the growing suffix, and
   `display` decides what the transcript shows. This barrel is the public
   surface; the per-module helpers stay internal to the directory. */
export type { AgentSegment } from "./agent-stream/segments.ts";
export { parseAgentStream, parseAgentStderr } from "./agent-stream/parse.ts";
export { AgentStreamAccumulator } from "./agent-stream/accumulator.ts";
export {
  agentMessagePlainText,
  commandDisplay,
  displayAgentSegments,
  displayAgentStreamSegments,
  hasStreamingTextCaret,
  hasTerminalOutcome,
  reasoningOutline,
  reasoningSummary,
  segmentKeys,
  userVisibleAgentSegments,
} from "./agent-stream/display.ts";
