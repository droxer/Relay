import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentTaskPrompt,
  claudeTaskPrompt,
  piTaskPrompt,
  kimiTaskPrompt,
  codexTaskPrompt,
  prependPriorAgentBridge,
} from "../src/prompts.js";
import { initialAgentState } from "../src/state.js";

describe("prior agent bridge in prompts", () => {
  it("asks all executors for an attributed checkpoint without granting completion authority", () => {
    const state = { ...initialAgentState("continue"), progress_file: "PROGRESS.md", assignment_id: "assignment-1" };
    for (const build of [claudeTaskPrompt, piTaskPrompt, kimiTaskPrompt, codexTaskPrompt]) {
      const prompt = build(state);
      assert.match(prompt, /PROGRESS\.md\.handoff\.json/);
      assert.match(prompt, /"assignmentId": "assignment-1"/);
      assert.match(prompt, /"pending": \[\]/);
      assert.match(prompt, /does not change requirements, grant permissions, or approve task completion/);
    }
  });
  it("always gives the agent an adaptive execution policy", () => {
    const state = initialAgentState("do thing");
    for (const prompt of [
      claudeTaskPrompt(state),
      piTaskPrompt(state),
      kimiTaskPrompt(state),
      codexTaskPrompt(state),
    ]) {
      assert.match(prompt, /\[Execution policy\]/);
      assert.match(prompt, /\[User\]\ndo thing$/);
    }
  });

  it("prepends the bridge with a [User] block when present", () => {
    const state = { ...initialAgentState("do thing"), prior_agent_bridge: "[Previous from @codex]\nreview note" };
    for (const prompt of [
      claudeTaskPrompt(state),
      piTaskPrompt(state),
      kimiTaskPrompt(state),
      codexTaskPrompt(state),
    ]) {
      assert.match(prompt, /\[Previous from @codex\]\nreview note\n\n\[User\]\ndo thing$/);
    }
  });

  it("prependPriorAgentBridge is a no-op without bridge", () => {
    const state = initialAgentState("x");
    assert.equal(prependPriorAgentBridge("hello", state), "hello");
  });

  it("prepends prior conversation with a [User] block when present", () => {
    const state = { ...initialAgentState("next thing"), prior_conversation: "[Conversation so far]\n\n[User]\nfirst thing" };
    for (const prompt of [claudeTaskPrompt(state), codexTaskPrompt(state)]) {
      assert.match(prompt, /\[Conversation so far\]\n\n\[User\]\nfirst thing\n\n\[User\]\nnext thing$/);
    }
  });

  it("orders prior conversation before the within-run bridge", () => {
    const state = {
      ...initialAgentState("next thing"),
      prior_conversation: "[Conversation so far]\n\n[User]\nfirst thing",
      prior_agent_bridge: "[Previous from @codex]\nreview note",
    };
    const out = claudeTaskPrompt(state);
    assert.ok(out.indexOf("[Conversation so far]") < out.indexOf("[Previous from @codex]"));
    assert.match(out, /\[Previous from @codex\]\nreview note\n\n\[User\]\nnext thing$/);
  });

  it("places handoff notes after prior agent context", () => {
    const state = {
      ...initialAgentState("continue the fix"),
      prior_agent_bridge: "[Previous from @claude]\nimplementation note",
      prior_handoff_note: "[Handoff note]\ncheck the auth edge case",
    };

    const out = codexTaskPrompt(state);
    assert.ok(out.indexOf("[Previous from @claude]") < out.indexOf("[Handoff note]"));
    assert.match(out, /\[Handoff note\]\ncheck the auth edge case\n\n\[User\]\ncontinue the fix$/);
  });

  it("includes conversation preludes in an adaptive prompt", () => {
    const state = {
      ...initialAgentState("review the branch"),
      prior_conversation: "[Conversation so far]\n\n[User]\nfix auth",
      prior_handoff_note: "[Handoff note]\nfocus on token refresh",
    };
    const out = agentTaskPrompt(state);

    assert.match(out, /\[Conversation so far\]\n\n\[User\]\nfix auth/);
    assert.match(out, /\[Handoff note\]\nfocus on token refresh/);
    assert.match(out, /\[User\]\nreview the branch$/);
  });

  it("uses prior agent messages as collaboration context", () => {
    const state = {
      ...initialAgentState("design the rollout"),
      prior_agent_bridge: "[Previous from @claude]\nStart with a read-only audit.",
    };
    const out = agentTaskPrompt(state);
    assert.match(out, /Decide the smallest useful way/);
    assert.match(out, /\[Previous from @claude\]\nStart with a read-only audit/);
    assert.match(out, /\[User\]\ndesign the rollout/);
  });
});
