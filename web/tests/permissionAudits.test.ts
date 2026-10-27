import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentSegment } from "../src/lib/agent-stream/segments.js";
import { segmentKeys } from "../src/lib/agent-stream/display.js";
import { placePermissionAudits } from "../src/lib/permissionAudits.js";
import type { PermissionAudit } from "../src/lib/projectMessages.js";

function audit(id: string, fields: Partial<PermissionAudit>): PermissionAudit {
  return { id, toolName: "Bash", outcome: "allow", tone: "info", label: "You allowed Bash", ...fields };
}

function place(segments: AgentSegment[], audits: PermissionAudit[]) {
  const keys = segmentKeys(segments);
  const placed = placePermissionAudits(segments, keys, audits);
  return {
    marks: keys.map((key) => placed.bySegment.get(key)?.id ?? null),
    unplaced: placed.unplaced.map((item) => item.id),
  };
}

describe("placePermissionAudits", () => {
  it("puts each approval on the tool line it let run, in order", () => {
    const segments: AgentSegment[] = [
      { kind: "text", text: "Fetching" },
      { kind: "tool", name: "Bash", target: "git fetch" },
      { kind: "tool", name: "Read", target: "/repo/a.ts" },
      { kind: "tool", name: "Bash", target: "git fetch" },
    ];
    assert.deepEqual(place(segments, [
      audit("a", { target: "git fetch" }),
      audit("b", { target: "git fetch", outcome: "deny", tone: "warn" }),
    ]), { marks: [null, "a", null, "b"], unplaced: [] });
  });

  it("prefers the runtime's tool call id over the text", () => {
    const segments: AgentSegment[] = [
      { kind: "tool", name: "Bash", target: "ls", id: "toolu_1" },
      { kind: "tool", name: "Bash", target: "ls", id: "toolu_2" },
    ];
    assert.deepEqual(place(segments, [audit("a", { target: "ls", toolUseId: "toolu_2" })]), { marks: [null, "a"], unplaced: [] });
  });

  it("matches a command line by its first line, as the tool line shows it", () => {
    const segments: AgentSegment[] = [{ kind: "command", command: "git status\ngit log" }];
    assert.deepEqual(place(segments, [audit("a", { target: "git status" })]), { marks: ["a"], unplaced: [] });
  });

  it("matches Codex approvals after native ids are translated for the stream", () => {
    const segments: AgentSegment[] = [{ kind: "command", command: "touch /outside", id: "item_0" }];
    assert.deepEqual(place(segments, [audit("a", { target: "touch /outside", toolUseId: "c1" })]), {
      marks: ["a"], unplaced: [],
    });
  });

  it("prefers an exact command id over an earlier translated-id target match", () => {
    const segments: AgentSegment[] = [
      { kind: "command", command: "ls", id: "item_0" },
      { kind: "command", command: "ls", id: "call_1" },
    ];
    assert.deepEqual(place(segments, [audit("a", { target: "ls", toolUseId: "call_1" })]), {
      marks: [null, "a"], unplaced: [],
    });
  });

  it("does not attach an approval to a different native tool call", () => {
    const segments: AgentSegment[] = [{ kind: "tool", name: "Bash", target: "ls", id: "toolu_1" }];
    assert.deepEqual(place(segments, [audit("a", { target: "ls", toolUseId: "toolu_2" })]), {
      marks: [null], unplaced: ["a"],
    });
  });

  it("keeps an audit no line matches as its own line in the turn", () => {
    const segments: AgentSegment[] = [{ kind: "tool", name: "Bash", target: "ls" }];
    assert.deepEqual(place(segments, [
      audit("q", { toolName: "AskUserQuestion", outcome: "answered" }),
      audit("x", { target: "rm -rf build" }),
    ]), { marks: [null], unplaced: ["q", "x"] });
  });
});
