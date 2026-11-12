// Deterministic Agent Runtime for the real-backend report integration tests.
// Only model execution and deliberate network faults are substituted.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runRelayDaemon } from '../../dist/index.js';
import { TerminalOutbox } from '../../dist/terminal-outbox.js';

const profile = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const origin = new URL(profile.url);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('E2E requires a disposable loopback backend.');
if (process.argv[3] === 'retry') {
  const outbox = new TerminalOutbox(join(profile.root, 'state', 'terminal-events'));
  outbox.retryQuarantined(process.argv[4], 'e2e-human-intervention');
  process.exit(0);
}
const trace = (kind, fields = {}) => appendFileSync(join(profile.root, 'trace.jsonl'), JSON.stringify({ kind, at: Date.now(), ...fields }) + '\n');
const commands = new Map();
const launched = new Set();
const usedFaults = new Set();
const stop = new AbortController();
process.on('SIGTERM', () => stop.abort());
process.on('SIGINT', () => stop.abort());

function faults() {
  try { return JSON.parse(readFileSync(join(profile.root, 'faults.json'), 'utf8')); }
  catch { return {}; }
}

const transport = async (url, init) => {
  const path = new URL(String(url)).pathname;
  if (path.endsWith('/commands') || path.endsWith('/heartbeat')) trace('request', { path });
  if ((path.endsWith('/events') || path.endsWith('/reports')) && faults().kind === 'offline-terminal') {
    const body = JSON.parse(init.body);
    const events = body.reports?.map(report => JSON.parse(report.body)) ?? [body];
    if (events.some(event => ['run.completed', 'run.cancelled', 'run.failed'].includes(event.type))) {
      trace('offline-terminal');
      throw new Error('E2E terminal transport unavailable until restart');
    }
  }
  const response = await fetch(url, init);
  if (path.endsWith('/commands') || path.endsWith('/heartbeat')) trace('connection-response', { path, status: response.status });
  if (path.endsWith('/commands') && response.ok) {
    for (const command of (await response.clone().json()).commands ?? []) {
      if (command.type === 'run.start') commands.set(command.id, command);
    }
  }
  if (path.endsWith('/daemon-node-registrations') && response.ok) trace('registered');
  if (path.endsWith('/events') || path.endsWith('/reports')) {
    const sent = JSON.parse(init.body);
    const reports = path.endsWith('/reports') ? sent.reports : [];
    const result = await response.clone().json().catch(() => ({}));
    trace('response', { path, status: response.status, type: sent.type, receipts: result.receipts, detail: result.detail });
    const fault = faults();
    const matches = reports.length || ['run.completed', 'run.cancelled', 'run.failed'].includes(sent.type);
    if (matches && fault.id && !usedFaults.has(fault.id) && response.ok) {
      usedFaults.add(fault.id);
      if (fault.kind === 'duplicate') {
        const duplicate = await fetch(url, init);
        trace('duplicate', { status: duplicate.status, body: await duplicate.json() });
      } else if (fault.kind === 'ack-loss') {
        await response.body?.cancel();
        trace('ack-loss', { id: fault.id });
        throw new Error('E2E acknowledgement lost after server commit');
      }
    }
  }
  return response;
};

const environment = {
  sandboxMode: 'none', ensureAgentReady: async () => {}, close: async () => {},
  async acquireWorkspace(workspace) {
    return { ensureAgentReady: this.ensureAgentReady,
      execStream: (cmd, args, options) => this.execStream(cmd, args, { ...options, probeWorkspace: workspace }),
      release: () => {} };
  },
  async execStream(_cmd, args, options) {
    if (args?.[1]?.includes("printf 'SKILL") || args?.[1]?.includes('emit()')) return { exit_code: 0, stdout: '', stderr: '' };
    const command = [...commands.values()].find(item => !launched.has(item.id)
      && resolve(profile.workspace, item.workspaceSubpath ?? `.threads/${item.sessionId}`) === resolve(options.probeWorkspace));
    if (!command) throw new Error(`E2E cannot identify workspace ${options.probeWorkspace}`);
    launched.add(command.id);
    trace('launch', { commandId: command.id, runId: command.runId, sessionId: command.sessionId });
    for (let index = 0; index < 8 && !options.signal?.aborted; index++) {
      const chunk = JSON.stringify({ type: 'item.completed', item: { id: `reply-${index}`, type: 'agent_message', text: `E2E reply ${index} for ${command.runId}` } }) + '\n';
      const rendered = options.stdoutRenderer?.(chunk);
      if (rendered) options.sink?.(rendered);
      await sleep(25);
    }
    while (existsSync(join(profile.root, 'hold')) && !options.signal?.aborted) await sleep(20);
    if (options.signal?.aborted) {
      trace('runtime-ended', { commandId: command.id, aborted: true });
      return { exit_code: 143, stdout: '', stderr: '', error_message: 'Cancelled in E2E' };
    }
    const control = join(options.probeWorkspace, '.relay');
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'round-result.json'), JSON.stringify({ status: 'done', runId: command.runId,
      work: { status: 'done', note: 'E2E completed.', evidence: ['Emitted eight deterministic replies.'] } }));
    trace('runtime-ended', { commandId: command.id, aborted: false });
    return { exit_code: 0, stdout: '', stderr: '' };
  },
};

try {
  await runRelayDaemon({ backendUrl: profile.url, sandboxId: profile.nodeId, token: profile.token,
    workspaceId: profile.workspaceId, workspacePath: profile.workspace, stateDir: join(profile.root, 'state'),
    sandbox: 'none', environment, fetchFn: transport, signal: stop.signal, preflight: false,
    pollIntervalMs: 20, shutdownGraceMs: 100, echoAgentOutput: false,
    ...profile.daemonOptions,
    logger: { info: (message, fields) => trace('info', { message, ...fields }),
      warn: (message, fields) => trace('warn', { message, ...fields }),
      error: (message, fields) => trace('error', { message, ...fields }), output: () => {} },
  });
} catch (error) { trace('fatal', { message: error.stack }); process.exitCode = 1; }
