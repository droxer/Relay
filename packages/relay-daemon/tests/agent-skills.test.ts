import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DaemonRunSkillBundle, SkillDelivery } from "relay-core";
import { materializeSkills } from "../src/agent-skills.js";
import { localProcessExecStream } from "../src/index.js";

const configDelivery: SkillDelivery = { kind: "config-dir", envVar: "CLAUDE_CONFIG_DIR", subdir: ".claude", skillsSubpath: "skills" };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-agent-skills-"));
  const agentHome = join(root, "home");
  const cacheDir = join(root, "cache");
  mkdirSync(agentHome, { recursive: true });
  const content = Buffer.from("---\nname: review\n---\nReview carefully.\n");
  const fileSha = createHash("sha256").update(content).digest("hex");
  const manifestSha = createHash("sha256").update("SKILL.md\0" + fileSha + "\n").digest("hex");
  const blobs: Record<string, Buffer> = { [fileSha]: content };
  const bundle = (slug = "review", revisionId = "rev-1"): DaemonRunSkillBundle => ({
    contract: { name: "relay.agent.skills", version: 1 },
    skills: [{ skillId: `skill-${createHash("sha256").update(slug).digest("hex").slice(0, 12)}`, revisionId, slug, manifestSha256: manifestSha, files: [{ path: "SKILL.md", sha256: fileSha, bytes: content.length }] }],
  });
  return { root, agentHome, cacheDir, blobs, bundle };
}

async function withFixture(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  try { await run(f); } finally { rmSync(f.root, { recursive: true, force: true }); }
}

test("materializes Pi paths in the execution environment and reuses the immutable cache", async () => withFixture(async (f) => {
  let fetches = 0;
  const options = {
    bundle: f.bundle(), agentId: "agent-a", delivery: { kind: "skill-path-flag", flag: "--skill", disableDiscoveryFlag: "--no-skills" } as const,
    agentHome: f.agentHome, cacheDir: f.cacheDir, execStream: localProcessExecStream,
    fetchBlob: async (sha: string) => { fetches += 1; return f.blobs[sha]!; },
  };
  const first = await materializeSkills(options);
  const second = await materializeSkills(options);
  assert.equal(readFileSync(join(first.skillPaths[0]!, "SKILL.md"), "utf8"), f.blobs[Object.keys(f.blobs)[0]!]!.toString());
  assert.equal(readdirSync(join(f.cacheDir, ".store")).length, 1);
  assert.deepEqual(second.skillPaths, first.skillPaths);
  assert.equal(fetches, 1);
  assert.equal(existsSync(join(f.agentHome, "agents")), false);
}));

test("creates immutable isolated config views and mirrors credentials by symlink", async () => withFixture(async (f) => {
  mkdirSync(join(f.agentHome, ".claude", "skills", "node-only"), { recursive: true });
  writeFileSync(join(f.agentHome, ".claude", "credentials.json"), "{}");
  const common = { delivery: configDelivery, agentHome: f.agentHome, cacheDir: f.cacheDir, execStream: localProcessExecStream, fetchBlob: async (sha: string) => f.blobs[sha]! };
  const a = await materializeSkills({ ...common, bundle: f.bundle("review"), agentId: "agent-a" });
  const b = await materializeSkills({ ...common, bundle: f.bundle("triage"), agentId: "agent-b" });
  assert.ok(lstatSync(join(a.env.CLAUDE_CONFIG_DIR!, "credentials.json")).isSymbolicLink());
  assert.deepEqual(readdirSync(join(a.env.CLAUDE_CONFIG_DIR!, "skills")), ["review"]);
  assert.deepEqual(readdirSync(join(b.env.CLAUDE_CONFIG_DIR!, "skills")), ["triage"]);
  assert.ok(existsSync(join(f.agentHome, ".claude", "skills", "node-only")));
}));

test("keeps concurrent revisions stable and gives Kimi one root containing slug directories", async () => withFixture(async (f) => {
  const common = { agentId: "same-agent", agentHome: f.agentHome, cacheDir: f.cacheDir, execStream: localProcessExecStream, fetchBlob: async (sha: string) => f.blobs[sha]! };
  const [a, b] = await Promise.all([
    materializeSkills({ ...common, bundle: f.bundle("review", "rev-1"), delivery: configDelivery }),
    materializeSkills({ ...common, bundle: f.bundle("triage", "rev-2"), delivery: configDelivery }),
  ]);
  assert.ok(existsSync(join(a.env.CLAUDE_CONFIG_DIR!, "skills", "review", "SKILL.md")));
  assert.ok(existsSync(join(b.env.CLAUDE_CONFIG_DIR!, "skills", "triage", "SKILL.md")));
  const kimi = await materializeSkills({ ...common, bundle: f.bundle("team/review"), delivery: { kind: "skills-dir-flag", flag: "--skills-dir" } });
  assert.equal(kimi.skillPaths.length, 1);
  assert.ok(existsSync(join(kimi.skillPaths[0]!, "review", "SKILL.md")));
  // Kimi only examines direct child directories of each --skills-dir root.
  const discovered = kimi.skillPaths.flatMap((root) => readdirSync(root).filter((entry) => existsSync(join(root, entry, "SKILL.md"))));
  assert.deepEqual(discovered, ["review"]);
}));

test("distinguishes a legacy missing bundle from an explicitly empty managed set", async () => withFixture(async (f) => {
  const common = { agentId: "agent-a", delivery: configDelivery, agentHome: f.agentHome, cacheDir: f.cacheDir, execStream: localProcessExecStream, fetchBlob: async (sha: string) => f.blobs[sha]! };
  assert.deepEqual(await materializeSkills({ ...common, bundle: undefined }), { skillPaths: [], env: {}, slugs: [], skipped: [] });
  const empty = await materializeSkills({ ...common, bundle: { contract: { name: "relay.agent.skills", version: 1 }, skills: [] } });
  assert.ok(empty.env.CLAUDE_CONFIG_DIR);
  assert.deepEqual(readdirSync(join(empty.env.CLAUDE_CONFIG_DIR!, "skills")), []);
}));

test("rejects traversal and digest mismatches without publishing partial trees", async () => withFixture(async (f) => {
  const bad = f.bundle();
  bad.skills[0]!.files[0]!.path = "../secret";
  const invalid = await materializeSkills({ bundle: bad, agentId: "agent-a", delivery: configDelivery, agentHome: f.agentHome, cacheDir: f.cacheDir, execStream: localProcessExecStream, fetchBlob: async (sha) => f.blobs[sha]! });
  assert.equal(invalid.skipped[0]?.reason, "invalid-bundle");
  assert.equal(existsSync(join(f.root, "secret")), false);

  const mismatch = await materializeSkills({ bundle: f.bundle(), agentId: "agent-a", delivery: configDelivery, agentHome: f.agentHome, cacheDir: f.cacheDir, execStream: localProcessExecStream, fetchBlob: async () => Buffer.from("wrong") });
  assert.equal(mismatch.skipped[0]?.reason, "blob-fetch-failed");
  assert.deepEqual(readdirSync(join(f.cacheDir, ".store")), []);
}));

test("reports network failures in safe empty views and refuses an unusable environment", async () => withFixture(async (f) => {
  mkdirSync(join(f.agentHome, ".claude"), { recursive: true });
  writeFileSync(join(f.agentHome, ".claude", "credentials.json"), "{}");
  const network = await materializeSkills({ bundle: f.bundle(), agentId: "agent-a", delivery: configDelivery, agentHome: f.agentHome, cacheDir: f.cacheDir, execStream: localProcessExecStream, fetchBlob: async () => { throw new Error("offline"); } });
  assert.equal(network.skipped[0]?.reason, "blob-fetch-failed");
  assert.deepEqual(readdirSync(join(network.env.CLAUDE_CONFIG_DIR!, "skills")), []);
  assert.ok(lstatSync(join(network.env.CLAUDE_CONFIG_DIR!, "credentials.json")).isSymbolicLink());
  const kimi = await materializeSkills({ bundle: f.bundle(), agentId: "agent-a", delivery: { kind: "skills-dir-flag", flag: "--skills-dir" }, agentHome: f.agentHome, cacheDir: join(f.root, "kimi-cache"), execStream: localProcessExecStream, fetchBlob: async () => { throw new Error("offline"); } });
  assert.equal(kimi.skillPaths.length, 1);
  assert.deepEqual(readdirSync(kimi.skillPaths[0]!), []);
  await assert.rejects(() => materializeSkills({ bundle: f.bundle(), agentId: "agent-a", delivery: configDelivery, agentHome: "/home/agent", cacheDir: "/home/agent/cache", fetchBlob: async (sha) => f.blobs[sha]!, execStream: async () => ({ exit_code: 1, stdout: "", stderr: "denied" }) }), /materialization failed/);
}));

test("reuses content-addressed blobs across different revisions", async () => withFixture(async (f) => {
  const common = Object.values(f.blobs)[0]!;
  const commonSha = createHash("sha256").update(common).digest("hex");
  const extra = Buffer.from("extra");
  const extraSha = createHash("sha256").update(extra).digest("hex");
  const make = (extraFile: boolean): DaemonRunSkillBundle => {
    const files = [{ path: "SKILL.md", sha256: commonSha, bytes: common.length }, ...(extraFile ? [{ path: "notes.txt", sha256: extraSha, bytes: extra.length }] : [])];
    const manifest = createHash("sha256");
    for (const file of files) manifest.update(`${file.path}\0${file.sha256}\n`);
    return { contract: { name: "relay.agent.skills", version: 1 }, skills: [{ skillId: "skill-review", revisionId: extraFile ? "rev-2" : "rev-1", slug: "review", manifestSha256: manifest.digest("hex"), files }] };
  };
  const counts = new Map<string, number>();
  const options = { agentId: "agent-a", delivery: { kind: "skill-path-flag", flag: "--skill", disableDiscoveryFlag: "--no-skills" } as const, agentHome: f.agentHome, cacheDir: f.cacheDir, execStream: localProcessExecStream, fetchBlob: async (sha: string) => { counts.set(sha, (counts.get(sha) ?? 0) + 1); return sha === commonSha ? common : extra; } };
  await materializeSkills({ ...options, bundle: make(false) });
  await materializeSkills({ ...options, bundle: make(true) });
  assert.equal(counts.get(commonSha), 1);
  assert.equal(counts.get(extraSha), 1);
}));

test("chunks a legal one MiB file below argv limits", async () => withFixture(async (f) => {
  const content = Buffer.alloc(1024 * 1024, 65);
  const fileSha = createHash("sha256").update(content).digest("hex");
  const manifestSha = createHash("sha256").update(`SKILL.md\0${fileSha}\n`).digest("hex");
  const bundle: DaemonRunSkillBundle = { contract: { name: "relay.agent.skills", version: 1 }, skills: [{ skillId: "skill-large", revisionId: "rev-large", slug: "large", manifestSha256: manifestSha, files: [{ path: "SKILL.md", sha256: fileSha, bytes: content.length }] }] };
  let largestArg = 0;
  const result = await materializeSkills({ bundle, agentId: "agent-a", delivery: { kind: "skill-path-flag", flag: "--skill", disableDiscoveryFlag: "--no-skills" }, agentHome: f.agentHome, cacheDir: f.cacheDir, fetchBlob: async () => content, execStream: async (cmd, args, options) => {
    largestArg = Math.max(largestArg, ...(args ?? []).map((arg) => Buffer.byteLength(arg)));
    return localProcessExecStream(cmd, args, options);
  } });
  assert.equal(readFileSync(join(result.skillPaths[0]!, "SKILL.md")).length, content.length);
  assert.ok(largestArg < 100_000, `largest argument was ${largestArg}`);
}));

test("detects tampered and symlinked cache entries and rebuilds them", async () => withFixture(async (f) => {
  let fetches = 0;
  const options = { bundle: f.bundle(), agentId: "agent-a", delivery: { kind: "skill-path-flag", flag: "--skill", disableDiscoveryFlag: "--no-skills" } as const, agentHome: f.agentHome, cacheDir: f.cacheDir, execStream: localProcessExecStream, fetchBlob: async (sha: string) => { fetches += 1; return f.blobs[sha]!; } };
  const first = await materializeSkills(options);
  writeFileSync(join(first.skillPaths[0]!, "SKILL.md"), "tampered");
  await materializeSkills(options);
  assert.equal(readFileSync(join(first.skillPaths[0]!, "SKILL.md"), "utf8"), Object.values(f.blobs)[0]!.toString());
  rmSync(join(first.skillPaths[0]!, "SKILL.md"));
  symlinkSync(join(f.root, "outside"), join(first.skillPaths[0]!, "SKILL.md"));
  writeFileSync(join(f.root, "outside"), Object.values(f.blobs)[0]!);
  await materializeSkills(options);
  assert.equal(lstatSync(join(first.skillPaths[0]!, "SKILL.md")).isSymbolicLink(), false);
  writeFileSync(join(first.skillPaths[0]!, "unexpected.md"), "not in manifest");
  await materializeSkills(options);
  assert.equal(existsSync(join(first.skillPaths[0]!, "unexpected.md")), false);
  assert.equal(fetches, 1, "the validated CAS blob repairs revisions without refetching");
}));

test("publishes one complete view when identical runs race", async () => withFixture(async (f) => {
  const options = { bundle: f.bundle(), agentId: "agent-a", delivery: configDelivery, agentHome: f.agentHome, cacheDir: f.cacheDir, execStream: localProcessExecStream, fetchBlob: async (sha: string) => f.blobs[sha]! };
  const results = await Promise.all(Array.from({ length: 6 }, () => materializeSkills(options)));
  assert.equal(new Set(results.map((result) => result.env.CLAUDE_CONFIG_DIR)).size, 1);
  assert.ok(results.every((result) => existsSync(join(result.env.CLAUDE_CONFIG_DIR!, "skills", "review", "SKILL.md"))));
  assert.equal(readdirSync(join(f.cacheDir, "views")).filter((name) => !name.startsWith(".tmp-")).length, 1);
}));

test("rejects file-count, per-file, and revision-size caps before fetching", async () => withFixture(async (f) => {
  let fetches = 0;
  const make = (files: Array<{ path: string; sha256: string; bytes: number }>): DaemonRunSkillBundle => {
    const manifestSha256 = createHash("sha256");
    for (const file of files) manifestSha256.update(`${file.path}\0${file.sha256}\n`);
    return { contract: { name: "relay.agent.skills", version: 1 }, skills: [{ skillId: "skill-caps", revisionId: "rev-caps", slug: "caps", manifestSha256: manifestSha256.digest("hex"), files }] };
  };
  const sha = "a".repeat(64);
  const bundles = [
    make(Array.from({ length: 301 }, (_, index) => ({ path: `f${index}`, sha256: sha, bytes: 1 }))),
    make([{ path: "large", sha256: sha, bytes: 1024 * 1024 + 1 }]),
    make(Array.from({ length: 5 }, (_, index) => ({ path: `f${index}`, sha256: sha, bytes: 1024 * 1024 }))),
  ];
  for (const bundle of bundles) {
    const result = await materializeSkills({ bundle, agentId: "agent-a", delivery: configDelivery, agentHome: f.agentHome, cacheDir: join(f.root, randomName()), execStream: localProcessExecStream, fetchBlob: async () => { fetches += 1; return Buffer.alloc(1); } });
    assert.equal(result.skipped[0]?.reason, "invalid-bundle");
    assert.deepEqual(readdirSync(join(result.env.CLAUDE_CONFIG_DIR!, "skills")), []);
  }
  assert.equal(fetches, 0);
}));

test("chunks maximum-count long-path metadata below argv limits", async () => withFixture(async (f) => {
  const content = Buffer.from("x"), digest = createHash("sha256").update(content).digest("hex");
  const files = [{ path: "SKILL.md", sha256: digest, bytes: 1 }, ...Array.from({ length: 299 }, (_, index) => ({
    path: `${String(index).padStart(3, "0")}-${"a".repeat(245)}.md`, sha256: digest, bytes: 1,
  }))];
  const manifest = createHash("sha256"); for (const file of files) manifest.update(`${file.path}\0${file.sha256}\n`);
  const bundle: DaemonRunSkillBundle = { contract: { name: "relay.agent.skills", version: 1 }, skills: [{ skillId: "skill-metadata", revisionId: "rev-metadata", slug: "metadata", manifestSha256: manifest.digest("hex"), files }] };
  let largestArg = 0;
  const result = await materializeSkills({ bundle, agentId: "agent-a", delivery: { kind: "skill-path-flag", flag: "--skill", disableDiscoveryFlag: "--no-skills" }, agentHome: f.agentHome, cacheDir: f.cacheDir, fetchBlob: async () => content, execStream: async (cmd, args, options) => {
    largestArg = Math.max(largestArg, ...(args ?? []).map((arg) => Buffer.byteLength(arg)));
    return localProcessExecStream(cmd, args, options);
  } });
  assert.equal(readdirSync(result.skillPaths[0]!).length, 300);
  assert.ok(largestArg < 100_000, `largest argument was ${largestArg}`);
}));

test("rejects symlinked cache roots and tampered immutable views", async () => withFixture(async (f) => {
  const outside = join(f.root, "outside-cache"); mkdirSync(outside);
  const unsafeCache = join(f.root, "unsafe-cache"); mkdirSync(unsafeCache); symlinkSync(outside, join(unsafeCache, ".store"));
  await assert.rejects(() => materializeSkills({ bundle: f.bundle(), agentId: "agent-a", delivery: configDelivery, agentHome: f.agentHome, cacheDir: unsafeCache, execStream: localProcessExecStream, fetchBlob: async (sha) => f.blobs[sha]! }), /materialization failed/);

  const options = { bundle: f.bundle(), agentId: "agent-a", delivery: configDelivery, agentHome: f.agentHome, cacheDir: f.cacheDir, execStream: localProcessExecStream, fetchBlob: async (sha: string) => f.blobs[sha]! };
  const first = await materializeSkills(options);
  const installed = join(first.env.CLAUDE_CONFIG_DIR!, "skills", "review");
  rmSync(installed); symlinkSync(outside, installed, "dir");
  await assert.rejects(() => materializeSkills(options), /materialization failed/);
}));

function randomName(): string { return `cache-${Math.random().toString(16).slice(2)}`; }
