import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureRuntimeProfile, loadRuntimeProfile, writeRuntimeProfile } from "../src/runtime-profile.js";

test("runtime profile preserves selected settings and references private credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-runtime-profile-"));
  try {
    const credentials = join(root, "runtime-env.json");
    writeFileSync(credentials, JSON.stringify({ OPENAI_API_KEY: "fixture-secret" }), { mode: 0o600 });
    const profile = captureRuntimeProfile({ HOME: root, PATH: "/usr/bin", CODEX_HOME: join(root, "custom"), HTTPS_PROXY: "http://localhost:8080", OPENAI_API_KEY: "fixture-secret", RELAY_DAEMON_NODE_TOKEN: "node-secret", UNRELATED: "private" }, credentials);
    const path = writeRuntimeProfile(root, profile);
    const saved = readFileSync(path, "utf8");
    assert.doesNotMatch(saved, /fixture-secret|node-secret|UNRELATED/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const env = loadRuntimeProfile(path);
    assert.equal(env.CODEX_HOME, join(root, "custom"));
    assert.equal(env.HTTPS_PROXY, "http://localhost:8080");
    assert.equal(env.OPENAI_API_KEY, "fixture-secret");
    assert.equal(env.RELAY_DAEMON_NODE_TOKEN, undefined);
    writeFileSync(credentials, JSON.stringify({ OPENAI_API_KEY: "rotated" }));
    assert.equal(loadRuntimeProfile(path).OPENAI_API_KEY, "rotated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("background setup cannot silently lose launch credentials or load arbitrary variables", () => {
  assert.throws(() => captureRuntimeProfile({ OPENAI_API_KEY: "secret" }), /runtime-env-file/);
  const root = mkdtempSync(join(tmpdir(), "relay-runtime-profile-"));
  try {
    const credentials = join(root, "env.json");
    writeFileSync(credentials, JSON.stringify({ NODE_OPTIONS: "--import=/untrusted.js" }), { mode: 0o600 });
    assert.throws(() => captureRuntimeProfile({}, credentials), /unsupported.*NODE_OPTIONS/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("runtime profile rejects exposed files and malformed values without echoing secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "relay-private-runtime-"));
  try {
    const file = join(root, "env.json");
    writeFileSync(file, '{"OPENAI_API_KEY":"private-value"}', { mode: 0o644 });
    assert.throws(() => captureRuntimeProfile({}, file), /private file/);
    chmodSync(file, 0o600);
    writeFileSync(file, '{"OPENAI_API_KEY":42}');
    assert.throws(() => captureRuntimeProfile({}, file), /Invalid runtime environment variable/);
    writeFileSync(file, 'secret invalid json');
    assert.throws(() => captureRuntimeProfile({}, file), error => error instanceof Error && !error.message.includes("secret"));
    const profile = writeRuntimeProfile(root, { version: 1, environment: {} });
    writeFileSync(profile, '{"version":2,"environment":{}}');
    assert.throws(() => loadRuntimeProfile(profile), /Unsupported/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
