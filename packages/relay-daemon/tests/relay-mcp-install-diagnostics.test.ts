import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configureRelayMcp, createMcpReconciler } from '../src/relay-mcp-bootstrap.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'relay-mcp-diagnostics-'));
  const options = { home, stateDir: join(home, 'state'), sandboxId: 'computer',
    backendUrl: 'https://relay.example', runtimes: ['codex', 'claude'], env: {} };
  const config = join(home, '.codex', 'config.toml');
  mkdirSync(join(home, '.codex'));
  return { home, options, config, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('invalid Codex TOML reports its path and remedy without exposing configuration contents', async () => {
  const f = fixture();
  const text = 'api_key = "private-test-secret" unexpected\n';
  writeFileSync(f.config, text);
  try {
    const reconcile = createMcpReconciler(async () => configureRelayMcp(f.options));
    const status = await reconcile(f.options.runtimes);
    assert.equal(status.status, 'blocked');
    assert.match(status.code!, /mcp_invalid_configuration/);
    assert.ok(status.code!.includes(f.config));
    assert.match(status.code!, /repair.*TOML/i);
    assert.doesNotMatch(status.code!, /private-test-secret/);
    assert.equal(readFileSync(f.config, 'utf8'), text);
    assert.match(readFileSync(join(f.home, '.claude.json'), 'utf8'), /relay-projects/);
  } finally { f.cleanup(); }
});

test('an edited entry reports the file and server name and preserves the edit', async () => {
  const f = fixture();
  try {
    configureRelayMcp(f.options);
    const edited = readFileSync(f.config, 'utf8').replace('command = ', '# user change\ncommand = "/custom/node" # ');
    writeFileSync(f.config, edited);
    const status = await createMcpReconciler(async () => configureRelayMcp(f.options))(f.options.runtimes);
    assert.equal(status.status, 'blocked');
    assert.match(status.code!, /mcp_configuration_conflict.*codex/);
    assert.ok(status.code!.includes(f.config));
    assert.match(status.code!, /relay-projects-[a-f0-9]+/);
    assert.match(status.code!, /review/i);
    assert.equal(readFileSync(f.config, 'utf8'), edited);
  } finally { f.cleanup(); }
});

test('a live installer lock is retrying and reconciliation succeeds after release', async () => {
  const f = fixture();
  const lock = join(f.home, '.relay', 'mcp', 'install.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  let now = 0;
  const reconcile = createMcpReconciler(async () => configureRelayMcp(f.options), () => now);
  try {
    const status = await reconcile(f.options.runtimes);
    assert.equal(status.status, 'retrying');
    assert.match(status.code!, /mcp_installation_busy/);
    assert.ok(status.code!.includes(lock));
    rmSync(lock, { recursive: true });
    now = 31_000;
    assert.equal((await reconcile(f.options.runtimes)).status, 'ready');
  } finally { f.cleanup(); }
});

test('filesystem failures are retryable and never mislabeled as user configuration conflicts', async () => {
  const f = fixture();
  // A directory at the config file path reliably produces EISDIR on all hosts.
  mkdirSync(f.config);
  try {
    const status = await createMcpReconciler(async () => configureRelayMcp(f.options))(f.options.runtimes);
    assert.equal(status.status, 'retrying');
    assert.match(status.code!, /mcp_installation_failed.*EISDIR/);
    assert.doesNotMatch(status.code!, /mcp_configuration_conflict/);
  } finally { f.cleanup(); }
});

test('missing Codex table inside ownership markers remains a configuration conflict', async () => {
  const f = fixture();
  try {
    configureRelayMcp(f.options);
    const edited = readFileSync(f.config, 'utf8').replace(/\[mcp_servers[^\n]*\]\n[\s\S]*?(?=# END)/, '');
    writeFileSync(f.config, edited);
    const status = await createMcpReconciler(async () => configureRelayMcp(f.options))(f.options.runtimes);
    assert.equal(status.status, 'blocked');
    assert.match(status.code!, /mcp_configuration_conflict/);
    assert.equal(readFileSync(f.config, 'utf8'), edited);
  } finally { f.cleanup(); }
});

test('invalid JSONC reports the affected runtime without leaking its contents', async () => {
  const f = fixture();
  const path = join(f.home, '.claude.json');
  const text = '{"secret":"private-test-secret" invalid}';
  writeFileSync(path, text);
  try {
    const status = await createMcpReconciler(async () => configureRelayMcp(f.options))(f.options.runtimes);
    assert.equal(status.status, 'blocked');
    assert.match(status.code!, /mcp_invalid_configuration \(claude\)/);
    assert.ok(status.code!.includes(path));
    assert.doesNotMatch(status.code!, /private-test-secret/);
    assert.equal(readFileSync(path, 'utf8'), text);
  } finally { f.cleanup(); }
});

test('an unsafe lock stays blocked and is preserved for inspection', async () => {
  const f = fixture();
  const lock = join(f.home, '.relay', 'mcp', 'install.lock');
  mkdirSync(join(f.home, '.relay', 'mcp'), { recursive: true });
  writeFileSync(lock, 'unowned');
  try {
    const status = await createMcpReconciler(async () => configureRelayMcp(f.options))(f.options.runtimes);
    assert.equal(status.status, 'blocked');
    assert.match(status.code!, /mcp_unsafe_installation_lock/);
    assert.ok(status.code!.includes(lock));
    assert.equal(readFileSync(lock, 'utf8'), 'unowned');
  } finally { f.cleanup(); }
});

test('mixed transient and persistent errors stay blocked and identify both runtimes', async () => {
  const f = fixture();
  mkdirSync(f.config);
  writeFileSync(join(f.home, '.claude.json'), '{invalid}');
  try {
    const status = await createMcpReconciler(async () => configureRelayMcp(f.options))(f.options.runtimes);
    assert.equal(status.status, 'blocked');
    assert.match(status.code!, /mcp_installation_failed \(codex\).*EISDIR/);
    assert.match(status.code!, /mcp_invalid_configuration \(claude\)/);
  } finally { f.cleanup(); }
});
