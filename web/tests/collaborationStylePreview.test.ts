import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import type { CollaborationStyle } from "relay-core";
import { previewSlots, type SlotMember } from "../src/lib/collaborationStyle.js";

// Written by backend/tests/unit/test_collaboration_templates.py from what team
// dispatch really fills, so the preview cannot drift from the backend alone.
type PreviewCase = {
  style: CollaborationStyle;
  leadId: string;
  members: SlotMember[];
  expected: ReturnType<typeof previewSlots>;
};

const cases = JSON.parse(
  readFileSync(resolve("backend/tests/unit/collaboration_style_previews.json"), "utf8"),
) as PreviewCase[];

describe("collaboration style preview", () => {
  it("has backend cases for every style", () => {
    assert.deepEqual(new Set(cases.map((item) => item.style)), new Set(["build_review", "pipeline", "lead_led"]));
  });

  it("shows the slots team dispatch fills", () => {
    for (const item of cases) {
      assert.deepEqual(
        previewSlots(item.members, item.leadId, item.style),
        item.expected,
        `${item.style} lead=${item.leadId} ${JSON.stringify(item.members)}`,
      );
    }
  });
});
