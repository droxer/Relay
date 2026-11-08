import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_NAMES, getAgent, commandExecution, initialAgentState } from 'relay-core';
import { localProcessExecStream } from '../src/local-runtime.js';
import { discoverAgentModels } from '../src/agent-models.js';
import { discoverAgentInventory } from '../src/agent-inventory.js';
import { npmShimTarget, windowsCommand, relayRun } from '../src/native-command.js';

function windows<T>(body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return body(); } finally { Object.defineProperty(process, 'platform', descriptor); }
}

function local<T>(body: () => T): T {
  const saved = process.env;
  process.env = { ...saved, RELAY_RUN_AS_CURRENT_USER: '1', RELAY_AGENT_HOME: tmpdir(), RELAY_AGENT_WORKSPACE: tmpdir() };
  try { return body(); } finally { process.env = saved; }
}

test('Windows builds every agent run and preflight without Bash', () => local(() => windows(() => {
  for (const agent of AGENT_NAMES) {
    const launch = getAgent(agent).permissionPrompts;
    const state = { ...initialAgentState('quotes " \' $() %PATH% & |\n中文'),
      permission_prompt: launch.kind === 'adapter' ? { adapter: launch.adapter, command: process.execPath, args: ['adapter.js'], env: { RELAY_TEST: 'a\'b' } } : undefined,
    };
    for (const script of [getAgent(agent).buildCommand(state, tmpdir()), getAgent(agent).preflight.command()]) {
      const invocation = commandExecution(script);
      assert.equal(invocation.command, 'relay-native');
      assert.doesNotMatch(script, /\/dev\/null|export HOME|grep |stdbuf |su agent/);
      // Generated scripts must parse with a top-level await, without running a real CLI.
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      assert.doesNotThrow(() => new AsyncFunction('relayRun', script));
    }
  }
})));

test('npm command shims resolve to Node entrypoints without cmd interpolation', () => {
  assert.equal(npmShimTarget('"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', 'C:\\Users\\Ana\\npm\\codex.cmd'),
    'C:\\Users\\Ana\\npm\\node_modules\\@openai\\codex\\bin\\codex.js');
  assert.equal(npmShimTarget('"%_prog%" "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*', 'C:\\npm\\opencode.cmd'), 'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode');
  assert.equal(npmShimTarget('@echo off\r\necho arbitrary wrapper %*', 'C:\\x.cmd'), undefined);
});

test('native execution preserves long Unicode arguments, environment, cwd and exit codes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-native-test-'));
  try {
    const fake = join(root, 'fake.cjs');
    writeFileSync(fake, `process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env.RELAY_TEST})); process.exitCode=Number(process.argv[2]);`);
    const argument = `"'\\$() %PATH% & |\n中文`.repeat(4000);
    const script = `process.env.RELAY_TEST='native'; process.chdir(${JSON.stringify(root)}); await relayRun(${JSON.stringify([process.execPath, fake, '7', argument])});`;
    const result = await localProcessExecStream('relay-native', [script]);
    assert.equal(result.exit_code, 7);
    assert.deepEqual(JSON.parse(result.stdout), { args: ['7', argument], cwd: realpathSync(root), env: 'native' });
    const missing = await localProcessExecStream('relay-native', ['await relayRun(["relay-missing-command-42"]);']);
    assert.equal(missing.exit_code, 127);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native Node eval transports large skill payloads outside argv', async () => {
  const payload = '中文'.repeat(30_000);
  const result = await localProcessExecStream('relay-native', [
    `await relayRun(${JSON.stringify([process.execPath, '-e', 'process.stdout.write(process.argv[1])', payload])});`,
  ]);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, payload);
});

test('native scripts respect cancellation and skip subsequent commands after failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-native-failure-'));
  try {
    const marker = join(root, 'marker');
    const result = await localProcessExecStream('relay-native', [
      `await relayRun(${JSON.stringify([process.execPath, '-e', 'process.exit(3)'])}); await relayRun(${JSON.stringify([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`])});`,
    ]);
    assert.equal(result.exit_code, 3);
    assert.throws(() => readFileSync(marker));
    const controller = new AbortController(); controller.abort();
    assert.equal((await localProcessExecStream('relay-native', ['throw Error("should not execute")'], { signal: controller.signal })).exit_code, -1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('Windows model and inventory discovery use native execution', async () => {
  const calls: string[] = [];
  const execute = async (command: string, args: string[] = []) => {
    calls.push(command);
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    assert.doesNotThrow(() => new AsyncFunction('relayRun', args[0]));
    return { exit_code: 0, stdout: '', stderr: '' };
  };
  await local(() => windows(() => discoverAgentModels(execute, AGENT_NAMES)));
  await local(() => windows(() => discoverAgentInventory(execute)));
  assert.deepEqual(calls, Array(AGENT_NAMES.length + 1).fill('relay-native'));
});


test('Windows resolves npm .cmd files instead of adjacent POSIX shims and preserves argv', () => {
  const entry = 'C:\\npm\\node_modules\\cli\\bin.js';
  const present = new Set(['C:\\npm\\codex', 'C:\\npm\\codex.cmd', entry, 'C:\\native\\kimi.exe']);
  const lookup = { path: 'C:\\npm;C:\\native', exists: (file: string) => present.has(file), read: () => '"%_prog%" "%dp0%\\node_modules\\cli\\bin.js" %*' };
  const args = ['--config', 'x="a b" & %PATH%'];
  assert.deepEqual(windowsCommand('codex', args, lookup), { command: process.execPath, args: [entry, ...args] });
  assert.deepEqual(windowsCommand('kimi', args, lookup), { command: 'C:\\native\\kimi.exe', args });
  assert.throws(() => windowsCommand('missing', [], lookup), /command not found/);
  assert.throws(() => windowsCommand('codex', [], { ...lookup, read: () => '@echo off' }), /batch wrapper/);
});

test('native model discovery keeps model ids and excludes provider credentials', async () => {
  const { nativeModelDiscoveryScript } = await import('../src/native-discovery.js');
  const { parseAgentModels } = await import('../src/agent-models.js');
  const cases = [
    { agent: 'codex', output: JSON.stringify({ models: [{ slug: 'gpt-test', visibility: 'list', priority: 0 }] }), expected: ['gpt-test'] },
    { agent: 'pi', output: 'provider model context\nopenai gpt-test 100000', expected: ['openai/gpt-test'] },
    { agent: 'kimi', output: JSON.stringify({ providers: { secret: 'do-not-emit' }, models: { 'kimi-test': {} } }), expected: ['kimi-test'] },
    { agent: 'opencode', output: 'openai/gpt-test\n', expected: ['openai/gpt-test'] },
  ] as const;
  for (const entry of cases) {
    const stub = `const relayRun = async () => ({code:0,stdout:${JSON.stringify(entry.output)},stderr:''});\n`;
    const result = await localProcessExecStream('relay-native', [stub + nativeModelDiscoveryScript(entry.agent)]);
    assert.equal(result.exit_code, 0, result.stderr);
    assert.deepEqual(parseAgentModels(entry.agent, result.stdout), entry.expected);
    for (const line of result.stdout.trim().split('\n')) {
      assert.doesNotMatch(Buffer.from(line.split('\t')[1] ?? '', 'base64').toString(), /do-not-emit/);
    }
  }
});

test('native inventory reads configured homes without Unix tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-native-inventory-'));
  try {
    const config = join(root, 'custom-codex');
    mkdirSync(join(config, 'skills', 'review'), { recursive: true });
    writeFileSync(join(config, 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\nReview');
    writeFileSync(join(config, 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-server"\n');
    let invocation: { command: string; args?: string[] } | undefined;
    await local(() => windows(() => discoverAgentInventory(async (command, args) => {
      invocation = { command, args }; return { exit_code: 0, stdout: '', stderr: '' };
    })));
    const result = await localProcessExecStream(invocation!.command, invocation!.args, { env: { HOME: root, CODEX_HOME: config } });
    assert.equal(result.exit_code, 0, result.stderr);
    const { parseInventoryOutput } = await import('../src/agent-inventory.js');
    const inventory = parseInventoryOutput(result.stdout);
    assert.equal(inventory.codex?.skills[0]?.name, 'review');
    assert.equal(inventory.codex?.mcpServers[0]?.name, 'docs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native Pi launch chooses JSON, streaming and legacy print modes from help', async () => {
  const { initialAgentState } = await import('relay-core');
  const command = local(() => windows(() => getAgent('pi').buildCommand(initialAgentState('test task'), tmpdir())));
  for (const [help, flag] of [['  --mode <mode>', '--mode'], ['  -P, --print-streaming', '-P'], ['--print', '-p']]) {
    const stub = `const relayRun = async argv => {
      if(argv[1]==='--help') return {code:0,stdout:${JSON.stringify(help)},stderr:''};
      process.stdout.write(JSON.stringify(argv)); return {code:0,stdout:'',stderr:''};
    };\n`;
    const result = await localProcessExecStream('relay-native', [stub + command]);
    assert.equal(result.exit_code, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).includes(flag));
  }
});

test('cancelling a live native run cleans its private script and argument files', async () => {
  const controller = new AbortController();
  const script = `await relayRun(${JSON.stringify([process.execPath, '-e', 'console.log(process.env.RELAY_NATIVE_TEMP_DIR); setInterval(()=>{},1000);'])});`;
  const result = await localProcessExecStream('relay-native', [script], {
    signal: controller.signal,
    sink: () => { controller.abort(); },
  });
  assert.notEqual(result.exit_code, 0);
  const directory = result.stdout.trim();
  assert.match(directory, /relay-native-/);
  assert.equal(existsSync(directory), false);
});

test('native Claude discovery uses saved login only for the vendor and emits model ids only', async () => {
  const { nativeModelDiscoveryScript } = await import('../src/native-discovery.js');
  const { parseAgentModels } = await import('../src/agent-models.js');
  const root = mkdtempSync(join(tmpdir(), 'relay-native-claude-'));
  try {
    writeFileSync(join(root, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'saved-test-token' } }));
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ model: 'configured-model' }));
    const stub = `const relayRun = async () => ({code:0,stdout:'',stderr:''});
      globalThis.fetch = async (url, options) => {
        if(url !== 'https://api.anthropic.com/v1/models?limit=1000' || options.headers.authorization !== 'Bearer saved-test-token') throw Error('incorrect request');
        return {ok:true,json:async()=>({data:[{id:'claude-versioned',secret:'do-not-emit'}]})};
      };\n`;
    // Keep the child process's Relay dotenv loader from importing host credentials.
    const env = { CLAUDE_CONFIG_DIR: root, ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '' };
    const result = await localProcessExecStream('relay-native', [stub + nativeModelDiscoveryScript('claude')], { env });
    assert.equal(result.exit_code, 0, result.stderr);
    assert.deepEqual(parseAgentModels('claude', result.stdout), ['claude-versioned']);
    const records = result.stdout.split('\n').map(line => Buffer.from(line.split('\t')[1] ?? '', 'base64').toString()).join('\n');
    assert.doesNotMatch(records, /saved-test-token|do-not-emit/);
    const custom = await localProcessExecStream('relay-native', [stub + nativeModelDiscoveryScript('claude')], {
      env: { ...env, ANTHROPIC_BASE_URL: 'https://custom.invalid' },
    });
    assert.deepEqual(parseAgentModels('claude', custom.stdout), ['configured-model']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skill materialization and cache reuse work through the native Node transport', async () => {
  const { createHash } = await import('node:crypto');
  const { materializeSkills } = await import('../src/agent-skills.js');
  const root = mkdtempSync(join(tmpdir(), 'relay-native-skills-'));
  try {
    const data = Buffer.from('---\nname: review\n---\n' + 'Native Unicode 中文\n'.repeat(6000));
    const sha = createHash('sha256').update(data).digest('hex');
    const manifest = createHash('sha256').update('SKILL.md\0' + sha + '\n').digest('hex');
    const options = {
      bundle: { contract: { name: 'relay.agent.skills' as const, version: 1 as const }, skills: [{ skillId: 'skill-1', revisionId: 'rev-1', slug: 'review', manifestSha256: manifest, files: [{ path: 'SKILL.md', sha256: sha, bytes: data.length }] }] },
      agentId: 'agent-1', delivery: { kind: 'prompt-paths' as const }, agentHome: root, cacheDir: join(root, 'cache'),
      fetchBlob: async () => data,
      execStream: (command: string, args: string[] = [], execOptions = {}) => localProcessExecStream('relay-native', [
        `await relayRun(${JSON.stringify([command === 'node' ? process.execPath : command, ...args])});`,
      ], execOptions),
    };
    const first = await materializeSkills(options);
    assert.deepEqual(readFileSync(join(first.skillPaths[0]!, 'SKILL.md')), data);
    const second = await materializeSkills({ ...options, fetchBlob: async () => { throw Error('must reuse cache'); } });
    assert.deepEqual(second.skillPaths, first.skillPaths);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native capture preserves diagnostics and explicitly suppressed stdout stays private', async () => {
  const argv = [process.execPath, '-e', 'console.log("private-output");console.error("diagnostic");process.exit(9)'];
  const result = await localProcessExecStream('relay-native', [
    `const result = await relayRun(${JSON.stringify(argv)}, {capture:true,allowFailure:true}); console.log(JSON.stringify(result));`,
  ]);
  assert.equal(result.exit_code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { code: 9, stdout: 'private-output\n', stderr: 'diagnostic\n' });
  const suppressed = await localProcessExecStream('relay-native', [
    `await relayRun(${JSON.stringify(argv)}, {capture:true,discardStdout:true});`,
  ]);
  assert.equal(suppressed.exit_code, 9);
  assert.match(suppressed.stderr, /diagnostic/);
  assert.doesNotMatch(suppressed.stdout + suppressed.stderr, /private-output/);
});

test('agent runs select native execution while retaining the executor output contract', async () => {
  const { runAgentNode } = await import('relay-core');
  let called = false;
  const outcome = await local(() => windows(() => runAgentNode('codex', initialAgentState('test task'), {
    workspacePath: tmpdir(),
    execStream: async (command, args, options) => {
      called = true;
      assert.equal(command, 'relay-native');
      assert.equal(args?.length, 1);
      assert.equal(options?.cwd, tmpdir());
      return { exit_code: 0, stdout: '', stderr: '' };
    },
  })));
  assert.ok(called);
  assert.equal(outcome.last_exit_code, 0);
});


test('native runtime launch streams its private multimodal input file to stdin', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-native-image-'));
  try {
    const file = join(directory, 'message.json');
    const message = JSON.stringify({type: 'user', message: {role: 'user', content: [{type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'aW1hZ2U='}}]}});
    writeFileSync(file, message, {mode: 0o600});
    const result = await relayRun([process.execPath, '-e', "process.stdout.write(require('node:fs').readFileSync(0))"], {capture: true, stdinFile: file});
    assert.equal(result.stdout, message);
    assert.equal(result.code, 0);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
