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

describe("groupActivity identity", () => {
  it("keeps a group object whose entries are unchanged, given the previous items", () => {
    const read = tool("Read");
    const grep = tool("Grep");
    const segments = [text("a"), read, grep, text("b")];
    const keys = ["t0", "r1", "g2", "t3"];
    const first = groupActivity(segments, keys);
    const second = groupActivity([...segments, text("c")], [...keys, "t4"], first);
    assert.equal(second[1], first[1], "the settled group is the same object");
    assert.deepEqual(second.map((item) => item.type), ["segment", "activity", "segment", "segment"]);
  });

  it("replaces a group when a call is appended to it", () => {
    const segments = [text("a"), tool("Read"), tool("Grep")];
    const keys = ["t0", "r1", "g2"];
    const first = groupActivity(segments, keys);
    const second = groupActivity([...segments, command("ls")], [...keys, "c3"], first);
    assert.notEqual(second[1], first[1]);
    assert.equal(second[1]!.type === "activity" && second[1]!.entries.length, 3);
  });

  it("does not hand out a group whose segment objects were replaced", () => {
    const first = groupActivity([tool("Read"), tool("Grep")], ["r0", "g1"]);
    const second = groupActivity([tool("Read"), tool("Grep")], ["r0", "g1"], first);
    assert.notEqual(second[0], first[0]);
  });
});
