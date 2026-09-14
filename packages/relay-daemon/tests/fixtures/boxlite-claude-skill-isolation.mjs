// Opt-in BoxLite acceptance check; build relay-core and relay-daemon first.
// No model/user message is sent. Pass an existing Relay devbox OCI rootfs as
// the first argument; this fixture never builds or exports an image.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { shellQuote } from "../../../relay-core/dist/index.js";
import { materializeSkills } from "../../dist/agent-skills.js";
import { BoxLiteExecutionManager } from "../../dist/execution.js";
import { createBoxliteEnvironment } from "../../dist/index.js";

assert.equal(process.platform, "darwin", "This probe requires BoxLite on macOS.");
const rootfsPath = resolve(process.argv[2] || "");
assert.ok(
  process.argv[2] && existsSync(join(rootfsPath, "oci-layout")),
  "Pass an existing Relay devbox OCI rootfs as the first argument.",
);

const root = mkdtempSync(join(tmpdir(), "relay-boxlite-skill-"));
const workspace = join(root, "workspace");
const boxliteHome = join(root, "boxlite");
mkdirSync(workspace);

class ExistingImageManager extends BoxLiteExecutionManager {
  ensureImage() {
    return rootfsPath;
  }
}

const environment = createBoxliteEnvironment(
  `skill-acceptance-${process.pid}`,
  workspace,
  { info() {}, warn() {}, error() {}, debug() {} },
  { boxliteHome, executionManager: new ExistingImageManager() },
);
const skillName = "relay-boxlite-acceptance";
const content = Buffer.from(
  `---\nname: ${skillName}\ndescription: BoxLite isolation acceptance.\n---\nAcceptance only.\n`,
);
const digest = createHash("sha256").update(content).digest("hex");
const manifestSha256 = createHash("sha256")
  .update(`SKILL.md\0${digest}\n`)
  .digest("hex");
const bundle = (skills) => ({
  contract: { name: "relay.agent.skills", version: 1 },
  skills,
});
const entry = {
  skillId: "skill-boxlite",
  revisionId: "revision-1",
  slug: skillName,
  manifestSha256,
  files: [{ path: "SKILL.md", sha256: digest, bytes: content.length }],
};
const materializerOptions = {
  delivery: {
    kind: "config-dir",
    envVar: "CLAUDE_CONFIG_DIR",
    subdir: ".claude",
    skillsSubpath: "skills",
  },
  agentHome: "/home/agent",
  cacheDir: "/home/agent/.relay/managed-skills",
  execStream: environment.execStream,
  fetchBlob: async (sha256) => {
    assert.equal(sha256, digest);
    return content;
  },
};

let probeNumber = 0;
async function discovered(configDir) {
  probeNumber += 1;
  const outputName = `claude-init-${probeNumber}.jsonl`;
  const initialize = `${JSON.stringify({
    type: "control_request",
    request_id: "boxlite-init",
    request: { subtype: "initialize" },
  })}\n`;
  const claude = [
    "claude",
    "--settings",
    JSON.stringify({ disableAllHooks: true, enabledPlugins: {} }),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "user",
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];
  const command =
    `export HOME=/home/agent CLAUDE_CONFIG_DIR=${shellQuote(configDir)} ` +
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; " +
    "cd /workspace; " +
    `printf %s ${shellQuote(Buffer.from(initialize).toString("base64"))} | base64 -d | ` +
    "HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 " +
    `${claude.map(shellQuote).join(" ")} > ${shellQuote(`/workspace/${outputName}`)}`;
  const result = await environment.execStream(
    "su",
    ["agent", "-s", "/bin/bash", "-c", command],
    { cwd: "/workspace" },
  );
  assert.equal(result.exit_code, 0, result.stderr || result.error_message);
  const records = readFileSync(join(workspace, outputName), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const response = records.find(
    (record) =>
      record.type === "control_response" &&
      record.response?.request_id === "boxlite-init",
  );
  assert.equal(response?.response?.subtype, "success");
  return response.response.response.commands.map((item) => item.name);
}

try {
  const granted = await materializeSkills({
    ...materializerOptions,
    agentId: "agent-a",
    bundle: bundle([entry]),
  });
  assert.ok(
    (await discovered(granted.env.CLAUDE_CONFIG_DIR)).includes(skillName),
    "Granted agent A must discover the skill inside BoxLite.",
  );
  assert.ok(
    !(await discovered("/home/agent/.claude")).includes(skillName),
    "Ungranted agent B must not discover A's skill inside BoxLite.",
  );
  const revoked = await materializeSkills({
    ...materializerOptions,
    agentId: "agent-a",
    bundle: bundle([]),
  });
  assert.ok(
    !(await discovered(revoked.env.CLAUDE_CONFIG_DIR)).includes(skillName),
    "Revoked agent A must not discover the skill on its next run.",
  );
  assert.ok(
    (await discovered(granted.env.CLAUDE_CONFIG_DIR)).includes(skillName),
    "The captured pre-revocation view must remain intact.",
  );
  console.log(
    "PASS: BoxLite guest materialization and Claude discovery isolation verified.",
  );
} finally {
  await environment.close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}
