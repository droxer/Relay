// Opt-in macOS acceptance check; build relay-core and relay-daemon first.
// No model/user message is sent. The OS sandbox blocks network and keychain
// access and permits writes only in the disposable test directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { materializeSkills } from "../../dist/agent-skills.js";
import { localProcessExecStream } from "../../dist/index.js";

assert.equal(process.platform, "darwin", "This probe requires macOS sandbox-exec.");
const executable = process.argv[2] || (process.env.PATH || "").split(":")
  .map((dir) => join(dir, "claude")).find(existsSync);
assert.ok(executable, "Pass the installed Claude executable as the first argument.");
const claude = realpathSync(executable);
const root = mkdtempSync(join(tmpdir(), "relay-claude-isolation-"));
const agentHome = join(root, "home");
const workspace = join(root, "workspace");
const bin = join(root, "bin");
const skillName = "relay-acceptance-a";
const content = Buffer.from(`---\nname: ${skillName}\ndescription: Temporary isolation check.\n---\nAcceptance only.\n`);
const digest = createHash("sha256").update(content).digest("hex");
const bundle = (skills) => ({ contract: { name: "relay.agent.skills", version: 1 }, skills });
const entry = {
  skillId: "skill-acceptance", revisionId: "revision-1", slug: skillName,
  manifestSha256: createHash("sha256").update(`SKILL.md\0${digest}\n`).digest("hex"),
  files: [{ path: "SKILL.md", sha256: digest, bytes: content.length }],
};
const options = {
  agentHome, cacheDir: join(root, "cache"), execStream: localProcessExecStream,
  delivery: { kind: "config-dir", envVar: "CLAUDE_CONFIG_DIR", subdir: ".claude", skillsSubpath: "skills" },
  fetchBlob: async (sha) => { assert.equal(sha, digest); return content; },
};

function discovered(configDir) {
  const quoted = (path) => JSON.stringify(path);
  const profile = `(version 1)
(allow default)
(deny network*)
(deny file-read* (subpath ${quoted(homedir())}) (subpath "/Library/Keychains") (subpath "/Library/Application Support/ClaudeCode"))
(allow file-read* (literal ${quoted(claude)}) (subpath ${quoted(root)}) (subpath ${quoted(realpathSync(root))}))
(deny file-write*)
(allow file-write* (subpath ${quoted(root)}) (subpath ${quoted(realpathSync(root))}) (literal "/dev/null"))
(deny process-exec (literal "/usr/bin/security"))
(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))`;
  const result = spawnSync("/usr/bin/sandbox-exec", [
    "-p", profile, claude,
    "--settings", JSON.stringify({ disableAllHooks: true, enabledPlugins: {} }),
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "user", "--print", "--verbose",
    "--input-format", "stream-json", "--output-format", "stream-json",
  ], {
    cwd: workspace, encoding: "utf8", timeout: 30_000,
    env: {
      PATH: `${bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: agentHome, CLAUDE_CONFIG_DIR: configDir, TMPDIR: join(root, "tmp"), NO_COLOR: "1",
    },
    input: JSON.stringify({ type: "control_request", request_id: "isolation-init", request: { subtype: "initialize" } }) + "\n",
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const response = records.find((record) => record.type === "control_response" && record.response?.request_id === "isolation-init");
  assert.equal(response?.response?.subtype, "success");
  return response.response.response.commands.map((command) => command.name);
}

try {
  for (const dir of [join(agentHome, ".claude"), workspace, bin, join(root, "tmp")]) mkdirSync(dir, { recursive: true });
  // Claude's startup invokes `security` by name. Simulate an empty keychain
  // without invoking the real tool (which remains denied by the OS sandbox).
  writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const granted = await materializeSkills({ ...options, agentId: "agent-a", bundle: bundle([entry]) });
  const other = await materializeSkills({ ...options, agentId: "agent-b", bundle: undefined });
  assert.deepEqual(other.env, {});
  assert.ok(discovered(granted.env.CLAUDE_CONFIG_DIR).includes(skillName), "Granted skill must be discovered by agent A.");
  assert.ok(!discovered(join(agentHome, ".claude")).includes(skillName), "Ungranted agent B must not discover A's skill.");
  const revoked = await materializeSkills({ ...options, agentId: "agent-a", bundle: bundle([]) });
  assert.ok(!discovered(revoked.env.CLAUDE_CONFIG_DIR).includes(skillName), "Revocation must remove the skill on A's next run.");
  assert.ok(discovered(granted.env.CLAUDE_CONFIG_DIR).includes(skillName), "Captured in-flight views must remain intact.");
  console.log("PASS: granted A discovers the skill; ungranted B and revoked A do not; captured A view remains intact.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
