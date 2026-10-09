import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { agentModel, modelIdProblem, modelPolicyFor, suggestedModels } from "../src/lib/agentModels.js";

describe("agent model selection", () => {
  it("suggests models only for the selected runtime", () => {
    assert.ok(suggestedModels("claude").every((model) => model.startsWith("claude-")));
    assert.ok(suggestedModels("codex").every((model) => model.startsWith("gpt-")));
    assert.deepEqual(suggestedModels(""), []);
    assert.deepEqual(suggestedModels("pi"), []);
  });

  it("reads the pinned model and treats an empty policy as the runtime default", () => {
    assert.equal(agentModel({ modelPolicy: { model: "gpt-5.1" } }), "gpt-5.1");
    assert.equal(agentModel({ modelPolicy: {} }), "");
    assert.equal(agentModel({}), "");
  });

  it("builds the wire policy, clearing it for a blank model", () => {
    assert.deepEqual(modelPolicyFor("  claude-opus-5-5 "), { model: "claude-opus-5-5" });
    assert.deepEqual(modelPolicyFor("  "), {});
  });

  it("mirrors the backend's model id shape rule", () => {
    for (const ok of ["claude-sonnet-5-5[1m]", "openai/gpt-5", "qwen3:32b", ""]) {
      assert.equal(modelIdProblem(ok), null, ok);
    }
    assert.equal(modelIdProblem("gpt 5"), "invalid");
    assert.equal(modelIdProblem("-m"), "invalid");
    assert.equal(modelIdProblem("x".repeat(129)), "too_long");
  });
});
