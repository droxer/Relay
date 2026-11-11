import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonLogWriter } from '../src/daemon-log-writer.js';

test('slow diagnostic writes have a byte bound and report dropped log records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-log-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const warnings: string[] = [];
  const writer = new DaemonLogWriter(root, join(root, 'daemon.log'), {
    maxQueueBytes: 1024, warn: message => warnings.push(message),
    append: async (path, data) => { await gate; await appendFile(path, data); },
  });
  for (let i = 0; i < 100; i++) writer.write('x'.repeat(256), `run-${i}`);
  assert.ok(writer.pendingBytes <= 1024);
  assert.ok(writer.dropped > 0);
  release();
  await writer.close();
  assert.ok(warnings.some(message => /omitted/.test(message)));
  assert.equal(writer.pendingBytes, 0);
});

test('diagnostic logger shutdown is bounded even if a write never finishes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-log-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const warnings: string[] = [];
  const writer = new DaemonLogWriter(root, join(root, 'daemon.log'), {
    closeTimeoutMs: 10, warn: message => warnings.push(message), append: () => new Promise(() => undefined),
  });
  writer.write('pending');
  await writer.close();
  assert.ok(warnings.some(message => /timed out/.test(message)));
});

test('startup trims oversized legacy logs and applies total retention before appending', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-log-existing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { writeFile, readdir, stat, readFile } = await import('node:fs/promises');
  for (const name of ['daemon.log', 'daemon.log.1', 'old-a.log', 'old-b.jsonl', 'old-c.log']) {
    await writeFile(join(root, name), 'x'.repeat(8192));
  }
  const writer = new DaemonLogWriter(root, join(root, 'daemon.log'), { maxFileBytes: 1024, maxRunBytes: 2048, maxRunFiles: 2 });
  writer.write('fresh\n', 'current');
  await writer.close();
  const names = await readdir(root);
  const runFiles = names.filter(name => !name.startsWith('daemon.log'));
  assert.ok(runFiles.length <= 2);
  let runBytes = 0;
  for (const name of names) {
    const size = (await stat(join(root, name))).size;
    assert.ok(size <= 1024, name);
    if (runFiles.includes(name)) runBytes += size;
  }
  assert.ok(runBytes <= 2048);
  assert.equal(await readFile(join(root, 'daemon.log'), 'utf8'), 'fresh\n');
});

test('a failed diagnostic append does not poison later writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'relay-log-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const warnings: string[] = [];
  let first = true;
  const writer = new DaemonLogWriter(root, join(root, 'daemon.log'), {
    warn: message => warnings.push(message),
    append: async (path, data) => { if (first) { first = false; throw new Error('disk unavailable'); } await appendFile(path, data); },
  });
  writer.write('first');
  writer.write('second');
  await writer.close();
  assert.ok(warnings.some(message => /disk unavailable/.test(message)));
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(root, 'daemon.log'), 'utf8'), 'second');
});
