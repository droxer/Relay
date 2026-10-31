import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { profileDraftDirty, profileDraftOf, profileDraftPatch } from "../src/lib/agentProfileDraft.js";

const agent = {
  displayName: "Ada",
  defaultRole: "implementer" as const,
  modelPolicy: { model: "gpt-5" },
  instructions: "Build things",
};

describe("agent profile draft", () => {
  it("starts from the saved agent and has nothing to save", () => {
    const saved = profileDraftOf(agent);
    assert.deepEqual(saved, { name: "Ada", role: "implementer", model: "gpt-5", instructions: "Build things" });
    assert.deepEqual(profileDraftPatch(saved, saved), {});
    assert.equal(profileDraftDirty(saved, saved), false);
  });

  it("ignores whitespace-only edits", () => {
    const saved = profileDraftOf(agent);
    const draft = { ...saved, name: " Ada ", model: "gpt-5 ", instructions: "Build things\n" };
    assert.equal(profileDraftDirty(saved, draft), false);
  });

  it("patches only the changed fields, trimmed, in one request", () => {
    const saved = profileDraftOf(agent);
    const draft = { ...saved, name: " Ada Two ", role: "reviewer" as const, instructions: "  Review  " };
    assert.deepEqual(profileDraftPatch(saved, draft), {
      displayName: "Ada Two",
      defaultRole: "reviewer",
      instructions: "Review",
    });
  });

  it("clears a pinned model back to the runtime default", () => {
    const saved = profileDraftOf(agent);
    assert.deepEqual(profileDraftPatch(saved, { ...saved, model: "" }), { modelPolicy: {} });
  });

  it("treats a missing role, model, and instructions as empty", () => {
    const saved = profileDraftOf({ displayName: "Bo" });
    assert.deepEqual(saved, { name: "Bo", role: "", model: "", instructions: "" });
    // An agent without a role keeps none until one is picked.
    assert.deepEqual(profileDraftPatch(saved, saved), {});
  });
});
