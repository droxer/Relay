import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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

describe("agent model on the agent record", () => {
  it("prints the model in the record panel beside the runtime, for every viewer", async () => {
    const detail = await readFile(resolve("web/src/components/AgentDetailPage.tsx"), "utf8");
    const runtime = detail.indexOf('key: "runtime"');
    const model = detail.indexOf('key: "model"');
    assert.ok(runtime >= 0 && model > runtime, "model fact must follow the runtime fact");
    assert.match(detail, /agentModel\(agent\)/);
    assert.match(detail, /agents_page\.model_default/);
  });

  it("keeps the profile's model row for editing only, so readers don't see it twice", async () => {
    const profile = await readFile(resolve("web/src/components/AgentProfilePanel.tsx"), "utf8");
    assert.match(profile, /\{canEditProfile \? \(\s*<div className="workspace-dossier-field">\s*<span[^>]*id=\{modelLabelId\}/);
    assert.doesNotMatch(profile, /savedModel \|\| t\("agents_page\.model_default"\)/);
  });
});
