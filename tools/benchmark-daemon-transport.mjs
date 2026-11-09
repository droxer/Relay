// Invoked by the disposable PostgreSQL harness; never targets a live service.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { runRelayDaemon } from '../packages/relay-daemon/dist/index.js';

function distribution(values, missing = 0, targetMs = 1000) {
  const sorted = [...values, ...Array(missing).fill(Infinity)].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  const finite = number => Number.isFinite(number) ? number : null;
  return { samples: sorted.length, missing, p50Ms: finite(percentile(.5)), p95Ms: finite(percentile(.95)),
    p99Ms: finite(percentile(.99)), maxMs: finite(sorted.at(-1)), misses: sorted.filter(value => value > targetMs).length };
}

if (isMainThread) {
  const profile = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (!profile.urls?.every(url => { const parsed = new URL(url); return parsed.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname); })) throw new Error('Probe requires disposable loopback servers.');
  const workers = [];
  const results = [];
  let ready = 0;
  const done = [];
  for (let index = 0; index < profile.daemons; index++) {
    const nodeId = randomUUID();
    const registration = await fetch(`${profile.urls[index % profile.urls.length]}/_probe/next`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Probe': profile.secret },
      body: JSON.stringify({ nodeId, register: true }),
    });
    if (!registration.ok) throw new Error(`Fixture registration refused: ${registration.status}`);
    const { token } = await registration.json();
    const worker = new Worker(new URL(import.meta.url), { workerData: { ...profile, nodeId, token, index } });
    workers.push(worker);
    done.push(new Promise((resolve, reject) => {
      worker.on('message', message => {
        if (message.ready) {
          if (++ready === profile.daemons) {
            const startAt = Date.now() + 1000;
            writeFileSync(join(profile.root, 'start.json'), JSON.stringify({ startAt }), { mode: 0o600 });
            for (const item of workers) item.postMessage({ startAt });
          }
        } else { results.push(message); resolve(); }
      });
      worker.on('error', reject);
      worker.on('exit', code => { if (code) reject(new Error(`Synthetic daemon exited ${code}`)); });
    }));
  }
  try {
    await Promise.all(done);
    const commands = results.flatMap(result => result.commands);
    const output = results.flatMap(result => result.output);
    const missedCommands = results.reduce((sum, result) => sum + result.missedCommands, 0);
    const missedOutput = results.reduce((sum, result) => sum + result.missedOutput, 0);
    const commandStats = distribution(commands, missedCommands);
    const outputStats = distribution(output, missedOutput);
    const recovery = results.filter(result => result.recoveryMs !== null).map(result => result.recoveryMs);
    const recoveryStats = profile.fault === 'none' ? null : distribution(recovery, profile.daemons - recovery.length, 5000);
    const full = profile.daemons === 100 && profile.duration >= 600 && profile.warmup >= 120 && profile.rttMs === 100 && commandStats.samples >= 10000 && outputStats.samples >= 10000;
    const errors = results.flatMap(result => result.errors);
    const artifact = { profile: { daemons: profile.daemons, durationSeconds: profile.duration, warmupSeconds: profile.warmup,
        rttMs: profile.rttMs, runsPerDaemon: 3, outputBytesPerRunPerSecond: 10240, fault: profile.fault, faultSeconds: profile.faultSeconds },
      environment: profile.environment, referenceProfile: full, command: commandStats, output: outputStats,
      recovery: recoveryStats, duplicateLaunches: results.reduce((sum, result) => sum + result.duplicates, 0), errors,
      verifiedHealthyTargets: profile.fault === 'none' && commandStats.samples > 0 && outputStats.samples > 0 && commandStats.p95Ms !== null && commandStats.p95Ms <= 1000 && outputStats.p95Ms !== null && outputStats.p95Ms <= 1000 && !errors.length,
      perDaemon: results.map(({ commands, output, ...result }) => ({ ...result, command: distribution(commands, result.missedCommands), output: distribution(output, result.missedOutput) })),
      limitations: ['Synthetic Agent Runtime bodies; no model calls.', 'Single-host clock; acknowledgement times conservatively include return RTT.',
        'Reference resource allocation and Linux/Windows/reboot coverage require separate evidence.',
        'Each invocation has one fault episode; repeat at least 20 independently timed cycles for recovery acceptance.'] };
    writeFileSync(profile.output, JSON.stringify(artifact, null, 2));
    console.log(JSON.stringify({ artifact: profile.output, referenceProfile: full, command: commandStats, output: outputStats, recovery: recoveryStats, errors: errors.length }));
    if (errors.length || artifact.duplicateLaunches || !commandStats.samples || !outputStats.samples) process.exitCode = 1;
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
} else {
  const profile = workerData;
  const { startAt } = await new Promise(resolve => { parentPort.once('message', resolve); parentPort.postMessage({ ready: true }); });
  await sleep(Math.max(0, startAt - Date.now()));
  const sampleStart = startAt + profile.warmup * 1000;
  const endAt = sampleStart + profile.duration * 1000;
  const faultStart = sampleStart + profile.duration * 1000 / 3;
  const restoredAt = faultStart + profile.faultSeconds * 1000;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), Math.max(1, endAt + 5000 - Date.now()));
  const root = join(profile.root, `daemon-${profile.index}`);
  mkdirSync(root, { recursive: true });
  const commands = [], output = [], errors = [];
  const delivered = new Set(), accepted = new Set(), launched = new Set(), finished = new Set(), submitted = new Set();
  const commits = new Map(), receivedAt = new Map(), sessions = new Map(), runIds = new Map(), rawTimes = new Map(), captures = new Map();
  let duplicates = 0, pollRecovered, reportRecovered;
  const inWindow = time => time >= sampleStart && time <= endAt;
  const nextRun = async () => {
    if (Date.now() >= endAt || stop.signal.aborted) return;
    const response = await fetch(`${profile.urls[profile.index % profile.urls.length]}/_probe/next`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Probe': profile.secret }, body: JSON.stringify({ nodeId: profile.nodeId }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Fixture run refused: ${response.status}`);
    const result = await response.json();
    commits.set(result.commandId, result.committedAt);
    if (inWindow(result.committedAt)) {
      submitted.add(result.commandId);
      if (receivedAt.has(result.commandId)) commands.push(receivedAt.get(result.commandId) - result.committedAt);
    }
  };
  const captureAcceptance = (event, now) => {
    for (const entry of event.entries ?? (event.type === 'run.output' ? [event] : [])) {
      const key = `${event.commandId}:${entry.sequence}`;
      if (captures.has(key) && !accepted.has(key)) { accepted.add(key); output.push(now - captures.get(key)); }
    }
    if (profile.fault !== 'none' && now >= restoredAt) reportRecovered ??= now;
    if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type) && !finished.has(event.commandId)) {
      finished.add(event.commandId);
      void nextRun().catch(error => { if (!stop.signal.aborted) errors.push(error.message); });
    }
  };
  const transport = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const impaired = profile.fault !== 'none' && Date.now() >= faultStart && Date.now() < restoredAt;
    if (impaired && profile.fault === 'blackhole') {
      await new Promise((_, reject) => { if (init?.signal?.aborted) reject(init.signal.reason); else init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
    }
    if (impaired && profile.fault === 'server-error') return new Response('Injected transient failure', { status: 503 });
    await sleep(profile.rttMs / 2, undefined, { signal: init?.signal });
    const endpoint = profile.urls[Math.floor(Math.random() * profile.urls.length)];
    const target = endpoint + new URL(String(url)).pathname + new URL(String(url)).search;
    const response = await fetch(target, init);
    if (impaired && profile.fault === 'duplicates' && (path.endsWith('/events') || path.endsWith('/reports'))) {
      const duplicate = await fetch(target, init); await duplicate.body?.cancel();
    }
    if (impaired && profile.fault === 'ack-loss' && !path.endsWith('/heartbeat')) {
      await response.body?.cancel(); throw new Error('Injected acknowledgement loss after commit');
    }
    await sleep(profile.rttMs / 2, undefined, { signal: init?.signal });
    if (response.ok) {
      const now = Date.now();
      if (path.endsWith('/commands')) {
        const body = await response.clone().json();
        if (profile.fault !== 'none' && now >= restoredAt) pollRecovered ??= now;
        for (const command of body.commands ?? []) if (command.type === 'run.start' && !delivered.has(command.id)) {
          delivered.add(command.id);
          receivedAt.set(command.id, now);
          const committedAt = commits.get(command.id);
          if (inWindow(committedAt)) commands.push(now - committedAt);
        }
      } else if (path.endsWith('/events') && response.headers.has('X-Relay-Report-Id')) {
        captureAcceptance(JSON.parse(init.body), now);
      } else if (path.endsWith('/reports')) {
        const sent = JSON.parse(init.body).reports;
        const receipts = (await response.clone().json()).receipts;
        for (const receipt of receipts ?? []) if (receipt.status === 200) {
          const report = sent.find(item => item.id === receipt.id && item.digest === receipt.digest);
          if (report) captureAcceptance(JSON.parse(report.body), now);
        }
      }
    }
    return response;
  };
  try {
    const daemon = runRelayDaemon({ backendUrl: profile.urls[0], sandboxId: profile.nodeId, token: profile.token,
      workspacePath: root, workspaceId: `probe-${profile.nodeId}`, stateDir: join(root, 'state'), sandbox: 'boxlite', signal: stop.signal, preflight: false,
      maxConcurrentRuns: 3, fetchFn: transport, echoAgentOutput: false,
      logger: { info: (message, fields) => {
        if (process.env.RELAY_TRANSPORT_PROBE_DEBUG) console.log(message, fields);
        if (message === 'command received') { sessions.set(fields.sessionId, fields.commandId); runIds.set(fields.commandId, fields.runId); }
        if (message === 'run starting') { if (launched.has(fields.commandId)) duplicates++; launched.add(fields.commandId); }
      }, warn: (message, fields) => { if (process.env.RELAY_TRANSPORT_PROBE_DEBUG) console.log(message, fields); }, error: (message, fields) => { if (process.env.RELAY_TRANSPORT_PROBE_DEBUG) console.log(message, fields); }, output: fields => {
        // The daemon can merge or split raw chunks before assigning a report
        // sequence. Consume their bytes, not one timestamp per merged report.
        // Otherwise every merged chunk leaves a timestamp behind and inflates
        // all subsequent measured latencies.
        const times = rawTimes.get(fields.commandId) ?? [];
        const at = times[0]?.at ?? Date.now();
        let remaining = Buffer.byteLength(fields.text);
        while (remaining > 0 && times.length) {
          const consumed = Math.min(remaining, times[0].bytes);
          remaining -= consumed;
          times[0].bytes -= consumed;
          if (!times[0].bytes) times.shift();
        }
        if (remaining) errors.push('Probe could not match captured output bytes to their raw timestamps.');
        if (inWindow(at)) captures.set(`${fields.commandId}:${fields.sequence}`, at);
      } },
      environment: { sandboxMode: 'boxlite', ensureAgentReady: async () => {}, close: async () => {},
        async acquireWorkspace(workspace) { return { ensureAgentReady: this.ensureAgentReady, execStream: (cmd, args, options) => this.execStream(cmd, args, { ...options, probeWorkspace: workspace }), release: () => {} }; },
        execStream: async (_command, args, options) => {
          if (args?.[1]?.includes("printf 'SKILL") || args?.[1]?.includes('emit()')) return { exit_code: 0, stdout: '', stderr: '' };
          const commandId = [...sessions].find(([session]) => options?.probeWorkspace?.includes(session))?.[1];
          if (!commandId) throw new Error('Synthetic capture cannot identify its Thread Workspace.');
          const deadline = Math.min(Date.now() + 10000, endAt);
          for (let tick = 0; Date.now() < deadline && !options?.signal?.aborted; tick++) {
            const chunk = JSON.stringify({ type: 'item.completed', item: { id: `chunk-${tick}`, type: 'agent_message', text: 'x'.repeat(1024) } }) + '\n';
            const times = rawTimes.get(commandId) ?? []; times.push({ at: Date.now(), bytes: Buffer.byteLength(chunk) }); rawTimes.set(commandId, times);
            const rendered = options?.stdoutRenderer?.(chunk);
            if (rendered) options?.sink?.(rendered);
            await sleep(100);
          }
          if (!options?.signal?.aborted) {
            // Fulfil the real run's completion contract, so the backend does
            // not enqueue a missing-report reminder as additional probe work.
            const control = join(options.probeWorkspace, '.relay');
            mkdirSync(control, { recursive: true });
            writeFileSync(join(control, 'round-result.json'), JSON.stringify({ status: 'done', runId: runIds.get(commandId),
              work: { status: 'done', note: 'Synthetic transport probe finished.', evidence: ['Emitted the configured synthetic output stream.'] } }));
          }
          return { exit_code: 0, stdout: '', stderr: '' };
        } },
    });
    await Promise.all([nextRun(), nextRun(), nextRun()]);
    await daemon;
  } catch (error) { errors.push(error.message); }
  finally { clearTimeout(timer); stop.abort(); }
  const missedCommands = [...submitted].filter(id => !delivered.has(id)).length;
  parentPort.postMessage({ nodeId: profile.nodeId, commands, output, missedCommands, missedOutput: [...captures.keys()].filter(key => !accepted.has(key)).length,
    duplicates, errors, recoveryMs: profile.fault === 'none' || pollRecovered === undefined || reportRecovered === undefined ? null : Math.max(pollRecovered, reportRecovered) - restoredAt });
}
