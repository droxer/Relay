import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDaemonLog } from '../src/daemon-log-format.js';

const time = '2026-10-23T10:00:00.000Z';

test('lifecycle logs include readable context and error details without JSON envelopes', () => {
  const text = formatDaemonLog(time, 'error', 'run failed', {
    agent: 'codex', runId: 'run-1', exitCode: 1, error: 'Not logged in\nRun codex login',
    ready: false, attempts: [1, 2], detail: { reason: 'authentication' }, ignored: undefined,
  });
  assert.match(text, /ERROR\s+\[codex · run run-1\] run failed/);
  assert.match(text, /exit code: 1/);
  assert.match(text, /error: Not logged in/);
  assert.match(text, /error: Run codex login/);
  assert.match(text, /ready: false/);
  assert.match(text, /attempts: 1, 2/);
  assert.match(text, /detail: reason: authentication/);
  assert.doesNotMatch(text, /ignored|"timestamp"|"message"/);
});

test('each agent output line has its run and stream and strips terminal escapes', () => {
  const text = formatDaemonLog(time, 'output', 'agent output', {
    agent: 'claude', runId: 'run-2', stream: 'stderr', sequence: 3,
    text: '\x1b[31mFirst\x1b[0m\r\nSecond\n',
  });
  assert.equal(text, `${time} OUTPUT [claude · run run-2 · stderr] First\n${time} OUTPUT [claude · run run-2 · stderr] Second\n`);
});

test('plain lifecycle messages and empty output remain newline terminated', () => {
  assert.equal(formatDaemonLog(time, 'info', 'ready', {}), `${time} INFO   ready\n`);
  assert.equal(formatDaemonLog(time, 'output', 'agent output', {}), `${time} OUTPUT \n`);
});
