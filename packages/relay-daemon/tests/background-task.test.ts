import assert from 'node:assert/strict';
import test from 'node:test';
import { superviseBackgroundTask } from '../src/background-task.js';

test('critical task rejection or unexpected completion triggers failure exactly once', async () => {
  for (const fail of [false, true]) {
    const failures: unknown[] = [];
    await superviseBackgroundTask('replay', new AbortController().signal,
      async () => { if (fail) throw Error('storage failed'); }, error => { failures.push(error); });
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]), fail ? /storage failed/ : /replay.*stopped/);
  }
});

test('shutdown completion and abort rejection do not trigger a second shutdown', async () => {
  const stop = new AbortController();
  await superviseBackgroundTask('heartbeat', stop.signal, async () => {
    stop.abort(); throw Error('cancelled');
  }, () => assert.fail('normal shutdown is not a task failure'));
});

test('a failing shutdown handler is not invoked twice', async () => {
  let calls = 0;
  await assert.rejects(superviseBackgroundTask('replay', new AbortController().signal,
    async () => {}, () => { calls++; throw Error('shutdown failed'); }), /shutdown failed/);
  assert.equal(calls, 1);
});
