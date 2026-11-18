import { agentTranscriptLimit, BoundedAgentTranscript } from "relay-core";

/** Process capture and completed-run logs share one retention policy and cap. */
export class BoundedTextCapture extends BoundedAgentTranscript {
  constructor(limit = agentTranscriptLimit()) {
    super(limit);
  }
}
