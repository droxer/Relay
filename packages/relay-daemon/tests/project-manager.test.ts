import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProjectManagerBridge, managerWorkspaceTool } from '../src/project-manager.js';

const exec = promisify(execFile);

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
