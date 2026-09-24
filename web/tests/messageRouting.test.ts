import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveThreadMessageAddress,
  routeComposerMessage,
  threadMessageInput,
  threadMessageOperationKey,
  threadRoundTeam,
} from "../src/lib/messageRouting.js";
import type { MentionCandidate } from "../src/lib/mentions.js";

const activeAgent = { id: "researcher", executorKind: "claude" as const };

describe("composer message routing", () => {
  it("treats @agent text as ordinary input for the selected agent", () => {
    const routed = routeComposerMessage("@pi check this", activeAgent);

    assert.deepEqual(routed, { agentId: "researcher", agent: "claude", goal: "@pi check this" });
  });

  it("trims the message without changing its selected agent", () => {
    const routed = routeComposerMessage("  check this  ", activeAgent);

    assert.deepEqual(routed, { agentId: "researcher", agent: "claude", goal: "check this" });
  });
});

const candidates: MentionCandidate[] = [
  { id: "agent_lead", displayName: "Lead", eligible: true },
  { id: "agent_support", displayName: "Support Bot", eligible: true },
];

describe("thread message input", () => {
  it("resolves the agent selected in the composer footer", () => {
    const resolved = resolveThreadMessageAddress({
      text: "one more pass",
      candidates,
      defaultAgentId: "agent_support",
    });

    assert.deepEqual(resolved, {
      blocked: false,
      addressAgentIds: ["agent_support"],
    });
  });

  it("blocks a stale or unavailable footer selection instead of widening to the room", () => {
    assert.deepEqual(
      resolveThreadMessageAddress({
        text: "one more pass",
        candidates,
        defaultAgentId: "agent_missing",
      }),
      { blocked: true, reason: "selected-agent", addressAgentIds: [] },
    );
    assert.deepEqual(
      resolveThreadMessageAddress({
        text: "one more pass",
        candidates: [
          ...candidates,
          { id: "agent_offline", displayName: "Offline", eligible: false },
        ],
        defaultAgentId: "agent_offline",
      }),
      { blocked: true, reason: "selected-agent", addressAgentIds: [] },
    );
  });

  it("addresses the room when nobody is mentioned", () => {
    const input = threadMessageInput({
      text: "one more pass",
      addressAgentIds: [],
      userMessageId: "evt_1",
    });

    assert.deepEqual(input, {
      text: "one more pass",
      intent: "accomplish",
      userMessageId: "evt_1",
      idempotencyKey: "evt_1",
    });
  });

  it("narrows to the agents named at the head of the message", () => {
    const resolved = resolveThreadMessageAddress({
      text: "@Lead @Support Bot ship it",
      candidates,
      defaultAgentId: "agent_support",
    });

    assert.deepEqual(resolved.addressAgentIds, ["agent_lead", "agent_support"]);
  });

  it("keeps the mention in the text the agent sees", () => {
    const input = threadMessageInput({
      text: "@Lead ship it",
      addressAgentIds: ["agent_lead"],
      userMessageId: "evt_1",
    });

    assert.equal(input.text, "@Lead ship it");
  });

  it("blocks an unresolved mention instead of falling back to the room", () => {
    const resolved = resolveThreadMessageAddress({
      text: "@Scout can you look at this?",
      candidates,
    });

    assert.deepEqual(resolved, {
      blocked: true,
      reason: "mention",
      addressAgentIds: [],
    });
  });

  it("keeps intentional team and room messages unaddressed", () => {
    assert.deepEqual(
      resolveThreadMessageAddress({ text: "one more pass", candidates }),
      { blocked: false, addressAgentIds: [] },
    );
  });
});

describe("thread message operation identity", () => {
  it("changes when the selected responder changes for the same text", () => {
    const lead = threadMessageOperationKey({
      sessionId: "ses_1",
      text: "one more pass",
      intent: "accomplish",
      addressAgentIds: ["agent_lead"],
    });
    const support = threadMessageOperationKey({
      sessionId: "ses_1",
      text: "one more pass",
      intent: "accomplish",
      addressAgentIds: ["agent_support"],
    });

    assert.notEqual(lead, support);
  });

  it("treats the same addressed set as one operation regardless of order", () => {
    const first = threadMessageOperationKey({
      sessionId: "ses_1",
      text: "ship it",
      intent: "accomplish",
      addressAgentIds: ["agent_support", "agent_lead"],
    });
    const second = threadMessageOperationKey({
      sessionId: "ses_1",
      text: "ship it",
      intent: "accomplish",
      addressAgentIds: ["agent_lead", "agent_support"],
    });

    assert.equal(first, second);
  });
});

describe("thread round team", () => {
  it("runs a team thread's own team while the room is the target", () => {
    assert.deepEqual(
      threadRoundTeam({ threadTeamId: "team_a", pickedTeamId: null, roomTarget: true }),
      { teamId: "team_a", addressTeamId: null },
    );
  });

  it("lets a team thread hand a round to one agent", () => {
    assert.deepEqual(
      threadRoundTeam({ threadTeamId: "team_a", pickedTeamId: null, roomTarget: false }),
      { teamId: null, addressTeamId: null },
    );
  });

  it("addresses another team on the same computer explicitly", () => {
    assert.deepEqual(
      threadRoundTeam({ threadTeamId: "team_a", pickedTeamId: "team_b", roomTarget: true }),
      { teamId: "team_b", addressTeamId: "team_b" },
    );
    assert.deepEqual(
      threadRoundTeam({ threadTeamId: null, pickedTeamId: "team_b", roomTarget: true }),
      { teamId: "team_b", addressTeamId: "team_b" },
    );
  });

  it("sends a re-pick of the thread's own team as a room message", () => {
    assert.deepEqual(
      threadRoundTeam({ threadTeamId: "team_a", pickedTeamId: "team_a", roomTarget: false }),
      { teamId: "team_a", addressTeamId: null },
    );
  });

  it("names no team for an agent thread with nothing picked", () => {
    assert.deepEqual(
      threadRoundTeam({ threadTeamId: null, pickedTeamId: null, roomTarget: true }),
      { teamId: null, addressTeamId: null },
    );
  });
});

describe("thread message input with a team", () => {
  it("carries the addressed team instead of agents", () => {
    const input = threadMessageInput({
      text: "crew, take it",
      addressAgentIds: [],
      addressTeamId: "team_b",
      userMessageId: "evt_1",
    });

    assert.equal(input.addressTeamId, "team_b");
    assert.equal(input.addressAgentIds, undefined);
  });
});
