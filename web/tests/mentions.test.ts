import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeMentionQuery,
  applyMention,
  mentionCandidates,
  mentionSegments,
  parseMentions,
  replaceAddressRun,
  type MentionCandidate,
} from "../src/lib/mentions.js";
import type { UserAgent } from "../src/types.js";

const candidates: MentionCandidate[] = [
  { id: "agent_lead", displayName: "Lead", eligible: true },
  { id: "agent_support", displayName: "Support Bot", eligible: true },
  { id: "agent_far", displayName: "Remote", eligible: false, reason: "unavailable" },
];

function agent(overrides: Partial<UserAgent>): UserAgent {
  return {
    id: "agent_1",
    userId: "emp_1",
    displayName: "Agent One",
    executorKind: "claude",
    skillPolicy: {},
    toolPolicy: {},
    modelPolicy: {},
    enabled: true,
    version: 1,
    availability: "ready",
    placements: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as UserAgent;
}

function placement(daemonNodeId: string): UserAgent["placements"][number] {
  return {
    id: `pl_${daemonNodeId}`,
    agentId: "agent_1",
    userId: "emp_1",
    daemonNodeId,
    executorKind: "claude",
    desiredState: "active",
    status: "ready",
    priority: 100,
  } as UserAgent["placements"][number];
}

describe("mentionCandidates", () => {
  it("offers exactly the agents it was given, so `@` matches the picker", () => {
    const offered = mentionCandidates([
      agent({ id: "agent_here", displayName: "Here", placements: [placement("node_1")] }),
      agent({ id: "agent_also", displayName: "Also", placements: [placement("node_1")] }),
    ]);
    assert.deepEqual(offered.map((candidate) => candidate.id), [
      "agent_here",
      "agent_also",
    ]);
    assert.ok(offered.every((candidate) => candidate.eligible));
  });

  it("keeps an agent that cannot run listed, with the reason", () => {
    const [offered] = mentionCandidates([
      agent({ id: "agent_off", displayName: "Off", availability: "offline" }),
    ]);
    assert.equal(offered.eligible, false);
    assert.equal(offered.reason, "unavailable");
  });

  it("drops a deleted agent entirely", () => {
    assert.deepEqual(
      mentionCandidates([agent({ deletedAt: "2026-02-01T00:00:00.000Z" })]),
      [],
    );
  });
});

describe("parseMentions", () => {
  it("addresses one agent named at the head of the message", () => {
    const parsed = parseMentions("@Lead check the migration", candidates);
    assert.deepEqual(parsed.addressAgentIds, ["agent_lead"]);
    assert.equal(parsed.blocked, false);
  });

  it("addresses several agents named in a row", () => {
    const parsed = parseMentions("@Lead @Support Bot ship it", candidates);
    assert.deepEqual(parsed.addressAgentIds, ["agent_lead", "agent_support"]);
    assert.equal(parsed.mentions.length, 2);
  });

  it("matches the longest name so a prefix does not steal it", () => {
    const parsed = parseMentions("@Support Bot ping", candidates);
    assert.deepEqual(parsed.addressAgentIds, ["agent_support"]);
  });

  it("ignores case", () => {
    assert.deepEqual(parseMentions("@lead hello", candidates).addressAgentIds, [
      "agent_lead",
    ]);
  });

  it("treats a mention after the first word as prose, not addressing", () => {
    const parsed = parseMentions("tell @Lead I said hi", candidates);
    assert.deepEqual(parsed.addressAgentIds, []);
    assert.equal(parsed.blocked, false);
  });

  it("blocks the send on an unknown name instead of messaging the room", () => {
    const parsed = parseMentions("@Nobody hello", candidates);
    assert.deepEqual(parsed.addressAgentIds, []);
    assert.equal(parsed.blocked, true);
  });

  it("blocks an agent that cannot take a turn right now", () => {
    const parsed = parseMentions("@Remote hello", candidates);
    assert.deepEqual(parsed.addressAgentIds, []);
    assert.equal(parsed.blocked, true);
    assert.equal(parsed.mentions[0].reason, "unavailable");
  });

  it("resolves an ambiguous name to nobody", () => {
    const twins: MentionCandidate[] = [
      { id: "a", displayName: "Twin", eligible: true },
      { id: "b", displayName: "Twin", eligible: true },
    ];
    const parsed = parseMentions("@Twin hello", twins);
    assert.deepEqual(parsed.addressAgentIds, []);
    assert.equal(parsed.blocked, true);
  });

  it("blocks a leading mention while the roster is empty", () => {
    const parsed = parseMentions("@Lead hello", []);
    assert.equal(parsed.mentions[0]?.text, "@Lead");
    assert.equal(parsed.mentions[0]?.eligible, false);
    assert.equal(parsed.blocked, true);
  });

  it("addresses the room when nothing is mentioned", () => {
    const parsed = parseMentions("hello everyone", candidates);
    assert.deepEqual(parsed.addressAgentIds, []);
    assert.equal(parsed.blocked, false);
  });

  it("reports spans that cover exactly the mention text", () => {
    const parsed = parseMentions("@Lead ship it", candidates);
    const [mention] = parsed.mentions;
    assert.equal("@Lead ship it".slice(mention.start, mention.end), "@Lead");
  });

  it("dedupes an agent named twice", () => {
    const parsed = parseMentions("@Lead @Lead go", candidates);
    assert.deepEqual(parsed.addressAgentIds, ["agent_lead"]);
  });
});

describe("activeMentionQuery", () => {
  it("opens on a fresh @ at a word boundary", () => {
    assert.deepEqual(activeMentionQuery("@Le", 3), { query: "Le", start: 0 });
    assert.deepEqual(activeMentionQuery("hi @Le", 6), { query: "Le", start: 3 });
  });

  it("stays closed mid-word, where @ is part of something else", () => {
    assert.equal(activeMentionQuery("mail@example", 12), null);
  });

  it("closes once the fragment is too long to be a name", () => {
    assert.equal(activeMentionQuery("@a b c d", 8), null);
  });
});

describe("applyMention", () => {
  it("splices the name in and leaves the caret after it", () => {
    const applied = applyMention("@Le rest", 0, 3, "Lead");
    assert.equal(applied.text, "@Lead  rest");
    assert.equal(applied.caret, 6);
  });
});

describe("replaceAddressRun", () => {
  const run = (text: string, displayName: string) =>
    replaceAddressRun(text, parseMentions(text, candidates).mentions, displayName);

  it("renames the addressed agent, keeping the message", () => {
    assert.equal(run("@Lead ship it", "Support Bot"), "@Support Bot ship it");
  });

  it("collapses a multi-agent run to the single agent picked", () => {
    assert.equal(run("@Lead @Support Bot go", "Lead"), "@Lead go");
  });

  it("replaces a name that resolves to nobody, unblocking the send", () => {
    assert.equal(run("@Nobody hello", "Lead"), "@Lead hello");
  });

  it("leaves a draft that addresses the room untouched", () => {
    assert.equal(run("hello everyone", "Lead"), "hello everyone");
  });
});

describe("mentionSegments", () => {
  it("splits the draft into plain runs and mention runs, in order", () => {
    const text = "@Lead @Support Bot ship it";
    const segments = mentionSegments(text, parseMentions(text, candidates).mentions);
    assert.deepEqual(segments, [
      { text: "@Lead", mention: true, eligible: true },
      { text: " ", mention: false },
      { text: "@Support Bot", mention: true, eligible: true },
      { text: " ship it", mention: false },
    ]);
  });

  it("marks an ineligible mention so it can read as blocking", () => {
    const text = "@Remote hi";
    const segments = mentionSegments(text, parseMentions(text, candidates).mentions);
    assert.deepEqual(segments[0], { text: "@Remote", mention: true, eligible: false });
  });

  it("returns the whole draft as one plain run when nobody is addressed", () => {
    assert.deepEqual(mentionSegments("plain text", []), [
      { text: "plain text", mention: false },
    ]);
  });

  it("drops the empty leading run instead of emitting a blank segment", () => {
    const text = "@Lead go";
    const segments = mentionSegments(text, parseMentions(text, candidates).mentions);
    assert.equal(segments[0].text, "@Lead");
  });
});
