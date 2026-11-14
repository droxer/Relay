import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { it } from "node:test";
import type { AgentName } from "relay-core";
import { defaultModelDiscoveryScript } from "../src/agent-default-models.js";

it("reads configured defaults for every runtime without emitting other configuration", () => {
  const home = mkdtempSync(join(tmpdir(), "relay-default-models-"));
  try {
    const files = {
      ".claude/settings.json": JSON.stringify({ model: "claude-configured", apiKey: "private-value" }),
      ".codex/config.toml": 'model = "codex-root"\nprofile = "work"\n[profiles.work]\nmodel = "codex-profile"\n[mcp_servers.other]\nmodel = "wrong"',
      ".pi/agent/settings.json": JSON.stringify({ defaultProvider: "provider", defaultModel: "pi-configured" }),
      ".config/opencode/opencode.jsonc": '{ // saved setting\n "model": "provider/opencode-configured", /* note */ }',
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(home, file)), { recursive: true });
      writeFileSync(join(home, file), text);
    }
    const env = { PATH: process.env.PATH, HOME: home };
    for (const [agent, expected] of Object.entries({ claude: "claude-configured", codex: "codex-profile", pi: "provider/pi-configured", opencode: "provider/opencode-configured" })) {
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", defaultModelDiscoveryScript(agent as AgentName)], { env, encoding: "utf8" });
      assert.equal(output, `default-model\t${Buffer.from(expected).toString("base64")}\n`, agent);
      assert.ok(!output.includes("private-value"));
    }
    // Environment selection has precedence over saved Claude settings.
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", defaultModelDiscoveryScript("claude")], { env: { ...env, ANTHROPIC_MODEL: "env-model" }, encoding: "utf8" });
    assert.equal(output, `default-model\t${Buffer.from("env-model").toString("base64")}\n`);
    rmSync(join(home, ".codex"), { recursive: true });
    assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", defaultModelDiscoveryScript("codex")], { env, encoding: "utf8" }), "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
