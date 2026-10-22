import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWelcomeRecap, greetingName, greetingPeriod } from "../src/lib/welcomeRecap.js";
import type { ThreadItem } from "../src/lib/threads.js";
import type { RelaySession } from "../src/types.js";

const NOW = Date.parse("2026-10-22T18:00:00.000Z");
const HOUR = 3_600_000;

function item(
  id: string,
  status: RelaySession["status"],
  hoursAgo: number,
  runs: Array<{ agent: string; logicalAgentId?: string }> = [],
): ThreadItem {
  const session = {
    id,
    taskGoal: `goal ${id}`,
    status,
    createdAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    updatedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    agentRuns: runs,
  } as unknown as RelaySession;
  return { session };
}

describe("buildWelcomeRecap", () => {
  it("puts the thread waiting on the person first, then live work, then fresh results", () => {
    const recap = buildWelcomeRecap(
      [
        item("done-old", "completed", 30),
        item("run", "running", 0.1),
        item("ask", "waiting_for_human", 0.5),
        item("done-new", "completed", 1),
      ],
      [],
      NOW,
    );
    assert.deepEqual(recap.rows.map((row) => [row.kind, row.item.session.id]), [
      ["needs_you", "ask"],
      ["running", "run"],
      ["finished", "done-new"],
    ]);
  });

  it("only calls a thread finished when it completed within the last day and was not blocked", () => {
    const blocked = item("blocked", "completed", 2);
    const blockedItem = { ...blocked, session: { ...blocked.session, workOutcome: "blocked" } as RelaySession };
    const recap = buildWelcomeRecap([item("failed", "failed", 1), item("stale", "completed", 25), blockedItem], [], NOW);
    assert.deepEqual(recap.rows.map((row) => row.kind), ["needs_you"]);
  });

  it("caps each kind so the recap stays a glance, not a second thread list", () => {
    const many = Array.from({ length: 6 }, (_, i) => item(`ask-${i}`, "waiting_for_human", i));
    const recap = buildWelcomeRecap(many, [], NOW);
    assert.equal(recap.rows.length, 2);
    assert.equal(recap.needsYouTotal, 6);
  });

  it("counts the week's finished threads and the distinct agents that worked them", () => {
    const recap = buildWelcomeRecap(
      [
        item("a", "completed", 2, [{ agent: "claude", logicalAgentId: "ada" }]),
        item("b", "completed", 50, [{ agent: "codex", logicalAgentId: "cole" }, { agent: "claude", logicalAgentId: "ada" }]),
        item("c", "completed", 24 * 8, [{ agent: "pi", logicalAgentId: "pia" }]),
        item("d", "running", 1, [{ agent: "kimi" }]),
      ],
      [],
      NOW,
    );
    assert.deepEqual(recap.week, { finished: 2, agents: 2 });
  });

  it("is empty for a person with no recent threads", () => {
    const recap = buildWelcomeRecap([item("old", "completed", 24 * 30)], [], NOW);
    assert.equal(recap.rows.length, 0);
    assert.deepEqual(recap.week, { finished: 0, agents: 0 });
  });
});

describe("greetingPeriod", () => {
  it("names the part of the day by the local hour", () => {
    assert.equal(greetingPeriod(3), "late");
    assert.equal(greetingPeriod(9), "morning");
    assert.equal(greetingPeriod(14), "afternoon");
    assert.equal(greetingPeriod(20), "evening");
  });
});

describe("greetingName", () => {
  it("greets by the first word of the display name, else the username", () => {
    assert.equal(greetingName({ displayName: "Fei He", username: "fei" }), "Fei");
    assert.equal(greetingName({ displayName: "  ", username: "fei" }), "fei");
    assert.equal(greetingName({ username: "" }), "");
  });
});
