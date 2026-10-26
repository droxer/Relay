import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DefaultAgentOffer } from "../src/api-client/agents.js";
import { nextDefaultAgentOffer, splitDefaultAgentAnswer } from "../src/lib/defaultAgentOffers.js";
import type { AgentName } from "../src/types.js";

function offer(computerId: string, executorKinds: string[]): DefaultAgentOffer {
  return { computerId, computerName: computerId, executorKinds: executorKinds as AgentName[] };
}

describe("nextDefaultAgentOffer", () => {
  it("asks about the first computer not set aside", () => {
    const offers = [offer("a", ["claude"]), offer("b", ["codex"])];

    assert.equal(nextDefaultAgentOffer(offers, new Set())?.computerId, "a");
    assert.equal(nextDefaultAgentOffer(offers, new Set(["a"]))?.computerId, "b");
    assert.equal(nextDefaultAgentOffer(offers, new Set(["a", "b"])), null);
  });

  it("keeps only runtimes this build can name, in registry order", () => {
    const next = nextDefaultAgentOffer([offer("a", ["kimi", "future", "claude"])], new Set());

    assert.deepEqual(next?.executorKinds, ["claude", "kimi"]);
  });

  it("skips a computer that offers nothing nameable", () => {
    const next = nextDefaultAgentOffer([offer("a", ["future"]), offer("b", ["pi"])], new Set());

    assert.equal(next?.computerId, "b");
  });
});

describe("splitDefaultAgentAnswer", () => {
  it("creates the checked runtimes and declines the rest", () => {
    const answer = splitDefaultAgentAnswer(offer("a", ["claude", "codex", "kimi"]), new Set<AgentName>(["codex"]));

    assert.deepEqual(answer, { accept: ["codex"], decline: ["claude", "kimi"] });
  });

  it("declines everything when nothing is checked", () => {
    const answer = splitDefaultAgentAnswer(offer("a", ["claude"]), new Set());

    assert.deepEqual(answer, { accept: [], decline: ["claude"] });
  });
});
