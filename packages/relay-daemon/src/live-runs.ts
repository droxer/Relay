// Which live runs can take a message, keyed by the run's start command id.
// A run registers its broker's channel while its adapter can listen and
// removes it when it ends; `run.steer` answers from here, so a message for a
// run this daemon is not executing, or one without a channel, is `unavailable`
// and the backend falls back to stopping the run and sending it next.
import {
  getAgent,
  LIVE_MESSAGE_TEXT_LIMIT,
  type DaemonNodeEvent,
  type DaemonNodeSteerCommand,
} from "relay-core";
import type { LiveMessageChannel, LiveMessageOutcome } from "./live-message-channel.js";

export class LiveRuns {
  private readonly channels = new Map<string, LiveMessageChannel>();

  /** Makes a run's channel reachable; the returned function removes it. */
  register(commandId: string, channel: LiveMessageChannel): () => void {
    this.channels.set(commandId, channel);
    return () => {
      if (this.channels.get(commandId) === channel) this.channels.delete(commandId);
    };
  }

  /** The `run.steered` report for one `run.steer`. Never throws. */
  async steer(command: DaemonNodeSteerCommand): Promise<Extract<DaemonNodeEvent, { type: "run.steered" }>> {
    const outcome = await this.outcome(command);
    return {
      type: "run.steered",
      commandId: command.id,
      ...(command.leaseId ? { leaseId: command.leaseId } : {}),
      targetCommandId: command.commandId,
      sessionId: command.sessionId,
      runId: command.runId,
      agent: command.agent,
      messageId: command.messageId,
      outcome: outcome.outcome,
      ...(outcome.outcome === "delivered" ? { delivery: outcome.delivery } : { reason: outcome.reason }),
    };
  }

  private async outcome(command: DaemonNodeSteerCommand): Promise<LiveMessageOutcome> {
    const text = typeof command.text === "string" ? command.text.trim() : "";
    if (!text || text.length > LIVE_MESSAGE_TEXT_LIMIT) {
      return { outcome: "failed", reason: `A live message must contain 1–${LIVE_MESSAGE_TEXT_LIMIT} characters.` };
    }
    if (!command.messageId) return { outcome: "failed", reason: "A live message needs an id." };
    if (getAgent(command.agent).liveMessages.kind !== "adapter") {
      return { outcome: "unavailable", reason: "This runtime cannot take a message while it works." };
    }
    const channel = this.channels.get(command.commandId);
    if (!channel) return { outcome: "unavailable", reason: "This run is not taking messages on this computer." };
    return await channel.deliver(command.messageId, text);
  }
}

/** The daemon's one registry; runs and the command loop share it. */
export const liveRuns = new LiveRuns();
