import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexCommand, buildClaudeCommand, initialAgentState } from "../src/index.js";

test("Codex receives image input on exec and permission adapter paths", () => {
  const state = { ...initialAgentState("Describe"), input_images: [{ path: "/workspace/.relay/image.png", mediaType: "image/png" }] };
  assert.match(buildCodexCommand(state), /--image/);
  const previous = process.env.RELAY_RUN_AS_CURRENT_USER;
  process.env.RELAY_RUN_AS_CURRENT_USER = "1";
  try {
    assert.match(buildCodexCommand({ ...state, permission_prompt: { adapter: "codex-app-server", command: "node", args: ["adapter.js"], env: {} } }), /--image/);
  } finally {
    if (previous === undefined) delete process.env.RELAY_RUN_AS_CURRENT_USER;
    else process.env.RELAY_RUN_AS_CURRENT_USER = previous;
  }
});

test("Claude receives structured image input without image bytes on argv", () => {
  const state = { ...initialAgentState("Describe"), input_images: [{ path: "/workspace/.relay/image.png", mediaType: "image/png" }] };
  const command = buildClaudeCommand(state);
  assert.match(command, /--input-format stream-json/);
  assert.match(command, /image.png/);
});

test("Claude receives actual image blocks on stdin, including a resume fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-claude-image-"));
  const previous = process.env;
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const capture = join(root, "captured.json");
    const fake = join(bin, "claude");
    writeFileSync(fake, `#!/usr/bin/env node\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(capture)}, fs.readFileSync(0));`);
    chmodSync(fake, 0o755);
    const image = join(root, "image with spaces.png");
    const bytes = Buffer.from("test image bytes");
    writeFileSync(image, bytes);
    process.env = { PATH: `${bin}:${previous.PATH}`, RELAY_RUN_AS_CURRENT_USER: "1", RELAY_AGENT_HOME: root };
    const command = buildClaudeCommand({ ...initialAgentState("Describe $(touch unwanted)"), input_images: [{ path: image, mediaType: "image/png" }] }, root);
    assert.ok(!command.includes(bytes.toString("base64")));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync("bash", ["-c", command], { encoding: "utf8", env: process.env });
      assert.equal(result.status, 0, result.stderr);
      const message = JSON.parse(readFileSync(capture, "utf8"));
      assert.equal(message.type, "user");
      assert.equal(message.message.content[1].source.data, bytes.toString("base64"));
      assert.equal(message.message.content[1].source.media_type, "image/png");
      assert.ok(message.message.content[0].text.includes("$(touch unwanted)"));
    }
  } finally { process.env = previous; rmSync(root, { recursive: true, force: true }); }
});
