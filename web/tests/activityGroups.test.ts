import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activityCounts, groupActivity } from "../src/lib/activityGroups.js";
import type { AgentSegment } from "../src/lib/agentStream.js";

const text = (value: string): AgentSegment => ({ kind: "text", text: value });
const tool = (name: string): AgentSegment => ({ kind: "tool", name });
const command = (value: string): AgentSegment => ({ kind: "command", command: value });

describe("groupActivity", () => {
  it("folds consecutive tool and command segments into one group", () => {
    const segments = [text("a"), tool("Read"), tool("Grep"), command("ls"), text("b")];
    const items = groupActivity(segments, ["t0", "r1", "g2", "c3", "t4"]);

    assert.deepEqual(items.map((item) => item.type), ["segment", "activity", "segment"]);
    const group = items[1]!;
    assert.equal(group.type, "activity");
    if (group.type !== "activity") return;
    assert.equal(group.key, "r1");
    assert.deepEqual(group.entries.map((entry) => entry.index), [1, 2, 3]);
  });

  it("leaves a lone tool line as a plain segment", () => {
    const items = groupActivity([text("a"), tool("Read"), text("b")], ["t0", "r1", "t2"]);
    assert.deepEqual(items.map((item) => item.type), ["segment", "segment", "segment"]);
    assert.equal(items[1]!.type === "segment" && items[1]!.index, 1);
  });

  it("keeps a trailing run grouped so its last entry stays addressable", () => {
    const items = groupActivity([text("a"), command("ls"), command("pwd")], ["t0", "c1", "c2"]);
    const last = items.at(-1)!;
    assert.equal(last.type, "activity");
    if (last.type !== "activity") return;
    assert.equal(last.entries.at(-1)!.index, 2);
  });
});

describe("activityCounts", () => {
  it("counts tool calls and shell commands separately", () => {
    const counts = activityCounts([tool("Read"), command("ls"), tool("Edit"), command("pwd"), command("git status")]);
    assert.deepEqual(counts, { tools: 2, commands: 3 });
  });
});
