import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySessionEvent } from "../src/lib/sessionEvents.js";
import { stripLeadingQueueMentions, type QueueRecipient } from "../src/lib/threadQueue.js";
import type { RelaySession } from "../src/types.js";

it("projects durable queue events without mutating the prior session", () => {
  const session = { id: "thread", events: [], messageQueue: { messages: [], paused: false } } as unknown as RelaySession;
  const queue = { messages: [{ id: "q1", text: "Next step" }], paused: true };
  const event = { id: "queue-event", type: "session.queue" as const, sessionId: "thread", timestamp: "2026-11-12T00:00:00Z", queue };
  const updated = applySessionEvent(session, event);
  assert.deepEqual(updated.messageQueue, queue);
  assert.deepEqual(session.messageQueue?.messages, []);
  assert.equal(applySessionEvent(updated, event), updated);
});

describe("stripLeadingQueueMentions", () => {
  const recipients: Record<string, QueueRecipient> = {
    da_a: { name: "大 A", kind: "agent" },
    osiris: { name: "Osiris", kind: "agent" },
    lead: { name: "Lead", kind: "agent" },
    support: { name: "Support", kind: "agent" },
    support_bot: { name: "Support Bot", kind: "agent" },
    core_team: { name: "Core Team", kind: "team" },
  };

  it("1. strips a single leading @mention already shown by the recipient pill", () => {
    assert.equal(
      stripLeadingQueueMentions("@大 A 帮我改下样式", ["da_a"], recipients),
      "帮我改下样式",
    );
  });

  it("2. preserves messages queued via the footer picker without a leading @mention", () => {
    assert.equal(
      stripLeadingQueueMentions("帮我改下样式", ["da_a"], recipients),
      "帮我改下样式",
    );
  });

  it("3. strips all leading @mentions for multi-recipient messages (including >2 folded pills)", () => {
    assert.equal(
      stripLeadingQueueMentions("@大 A @Osiris 一起看下", ["da_a", "osiris"], recipients),
      "一起看下",
    );
    assert.equal(
      stripLeadingQueueMentions("@大 A @Osiris @Lead 一起看下", ["da_a", "osiris", "lead"], recipients),
      "一起看下",
    );
  });

  it("4. strips only the leading @mention run and preserves mid-sentence @mentions", () => {
    assert.equal(
      stripLeadingQueueMentions("@大 A 顺便通知 @Osiris", ["da_a"], recipients),
      "顺便通知 @Osiris",
    );
  });

  it("5. preserves non-leading @mentions unchanged", () => {
    assert.equal(
      stripLeadingQueueMentions("帮我问下 @大 A", ["da_a"], recipients),
      "帮我问下 @大 A",
    );
  });

  it("6. returns an empty displayText for a bare leading @mention so preview can fall back to raw text", () => {
    const raw = "@大 A";
    const displayText = stripLeadingQueueMentions(raw, ["da_a"], recipients);
    assert.equal(displayText, "");
    assert.equal(displayText || raw, "@大 A");
  });

  it("7. does not strip leading @mentions when any recipient is unavailable or unresolved", () => {
    assert.equal(
      stripLeadingQueueMentions("@大 A 帮我改下样式", ["missing_agent"], recipients),
      "@大 A 帮我改下样式",
    );
    assert.equal(
      stripLeadingQueueMentions("@大 A @Ghost 帮我改下样式", ["da_a", "missing_agent"], recipients),
      "@大 A @Ghost 帮我改下样式",
    );
    assert.equal(
      stripLeadingQueueMentions("@大 A @Osiris 帮我改下样式", ["da_a"], recipients),
      "@大 A @Osiris 帮我改下样式",
    );
  });

  it("8. does not strip leading @mentions for team recipients or project room messages", () => {
    assert.equal(
      stripLeadingQueueMentions("@Core Team 帮我改下样式", ["core_team"], recipients),
      "@Core Team 帮我改下样式",
    );
    assert.equal(
      stripLeadingQueueMentions("@大 A 帮我改下样式", [], recipients),
      "@大 A 帮我改下样式",
    );
  });

  it("9. matches case-insensitively and prefers the longest matching recipient name", () => {
    assert.equal(
      stripLeadingQueueMentions("@support bot check the logs", ["support_bot"], recipients),
      "check the logs",
    );
    assert.equal(
      stripLeadingQueueMentions("@Support Bot @SUPPORT check the logs", ["support_bot", "support"], recipients),
      "check the logs",
    );
    assert.equal(
      stripLeadingQueueMentions("@Support Bot check the logs", ["support"], recipients),
      "@Support Bot check the logs",
    );
  });
});
