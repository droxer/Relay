import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProjectManagerBridge, managerWorkspaceTool } from '../src/project-manager.js';

const exec = promisify(execFile);

test('managed MCP calls progress independently with bounded concurrency and disposal drains work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-manager-concurrent-'));
  const release = Promise.withResolvers<void>();
  const calls: number[] = [];
  let active = 0;
  let peak = 0;
  const bridge = createProjectManagerBridge(root, async (_tool, args) => {
    calls.push(Number(args.id));
    peak = Math.max(peak, ++active);
    if (args.id !== 1) await release.promise;
    active--;
    return args;
  });
  const dir = join(root, bridge.toolPath, '..');
  const ids = Array.from({ length: 20 }, (_, id) => `00000000-0000-0000-0000-${String(id).padStart(12, '0')}`);
  try {
    for (const [id, name] of ids.entries()) {
      writeFileSync(join(dir, name + '.request'), JSON.stringify({ tool: 'mcp', arguments: { id } }));
    }
    const deadline = Date.now() + 2000;
    while ((peak < 8 || !calls.includes(1)) && Date.now() < deadline) await delay(10);
    assert.ok(calls.includes(1), 'fast managed call must not wait for held calls');
    assert.equal(peak, 8);
    assert.ok(calls.length <= 9, 'only the completed fast call frees a slot');
  } finally {
    release.resolve();
    await bridge.dispose();
    assert.equal(active, 0);
    rmSync(root, { recursive: true, force: true });
  }
});

test('every runtime can invoke the file bridge without backend credentials in its helper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-manager-'));
  const calls: unknown[] = [];
  const bridge = createProjectManagerBridge(root, async (tool, args) => {
    calls.push([tool, args]);
    return { total: 7 };
  });
  try {
    const result = await exec(process.execPath, [join(root, bridge.toolPath), 'tasks', '{"status":"backlog"}']);
    assert.deepEqual(JSON.parse(result.stdout), { total: 7 });
    assert.deepEqual(calls, [['tasks', { status: 'backlog' }]]);
    assert.doesNotMatch(readFileSync(join(root, bridge.toolPath), 'utf8'), /Bearer|token_/);
  } finally { await bridge.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('tool errors reach the caller and disposal revokes its mailbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-manager-'));
  const bridge = createProjectManagerBridge(root, async () => { throw new Error('command inactive'); });
  try {
    await assert.rejects(exec(process.execPath, [join(root, bridge.toolPath), 'propose', '{}']), /command inactive/);
    await bridge.dispose();
    await assert.rejects(exec(process.execPath, [join(root, bridge.toolPath), 'tasks', '{}']));
  } finally { await bridge.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('workspace reads and search are bounded and cannot escape by path or symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-manager-'));
  const outside = mkdtempSync(join(tmpdir(), 'relay-outside-'));
  try {
    writeFileSync(join(root, 'README.md'), 'Release requires migration checks.');
    writeFileSync(join(outside, 'private.txt'), 'secret');
    symlinkSync(outside, join(root, 'escape'));
    const read = managerWorkspaceTool(root, 'file', { path: 'README.md' });
    assert.match(String(read.content), /migration/);
    assert.equal((managerWorkspaceTool(root, 'search', { query: 'migration' }).matches as unknown[]).length, 1);
    assert.throws(() => managerWorkspaceTool(root, 'file', { path: '../private.txt' }));
    assert.throws(() => managerWorkspaceTool(root, 'file', { path: 'escape/private.txt' }));
    mkdirSync(join(root, '.relay'));
    writeFileSync(join(root, '.relay', 'hidden'), 'migration');
    assert.equal((managerWorkspaceTool(root, 'search', { query: 'migration' }).matches as unknown[]).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
