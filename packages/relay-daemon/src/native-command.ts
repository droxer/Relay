/** Native Windows CLI launch: npm shims become Node entrypoints; no command shell interprets arguments. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { superviseLocalProcess } from './process-supervisor.js';

/** Only npm's quoted Node entrypoint is accepted; arbitrary batch programs are never evaluated. */
export function npmShimTarget(content: string, file: string): string | undefined {
  const target = /"%dp0%[\\/]([^"\r\n%]+)"\s+%\*/i.exec(content)?.[1];
  return target ? win32.resolve(win32.dirname(file), target) : undefined;
}

export interface WindowsCommandLookup {
  path: string;
  exists(file: string): boolean;
  read(file: string): string;
}

export function windowsCommand(command: string, args: string[], lookup: WindowsCommandLookup): { command: string; args: string[] } {
  if (command.toLowerCase() === 'node') return { command: process.execPath, args };
  // npm also writes a POSIX shim with no extension. Windows must choose .cmd,
  // even when that extensionless file exists beside it.
  const extensions = win32.extname(command) ? [''] : ['.exe', '.com', '.cmd', '.bat'];
  const directories = win32.isAbsolute(command) || /[\\/]/.test(command)
    ? [''] : lookup.path.split(';').filter(Boolean).map(part => part.replace(/^"|"$/g, ''));
  const file = directories.flatMap(directory => extensions.map(extension => win32.resolve(directory, command + extension)))
    .find(candidate => lookup.exists(candidate));
  if (!file) throw Object.assign(new Error(`${command}: command not found`), { code: 127 });
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args };
  const entry = npmShimTarget(lookup.read(file), file);
  if (!entry || !lookup.exists(entry)) {
    throw new Error(`Cannot run Windows batch wrapper ${file}. Use a native executable or an npm-installed CLI.`);
  }
  return { command: process.execPath, args: [entry, ...args] };
}

export function nativeCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  return process.platform !== 'win32' ? { command, args } : windowsCommand(command, args, {
    path: env.PATH ?? env.Path ?? '', exists: existsSync, read: file => readFileSync(file, 'utf8'),
  });
}

/** Runs inside the supervised native script, so every CLI remains in its execution tree. */
export async function relayRun(argv: string[], options: { capture?: boolean; allowFailure?: boolean; discardStdout?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const invocation = nativeCommand(argv[0]!, argv.slice(1));
  let temporary: string | undefined;
  // Node-based CLIs can receive even large prompts/config JSON without putting them on
  // Windows' command line. A preload sets argv before Node runs the real main module.
  if (invocation.command === process.execPath && invocation.args.length) {
    const [entry, ...rest] = invocation.args;
    if (entry === '-e' || entry === '--eval') {
      temporary = mkdtempSync(join(process.env.RELAY_NATIVE_TEMP_DIR ?? tmpdir(), 'node-'));
      const file = join(temporary, 'eval.cjs');
      writeFileSync(file, `process.argv = ${JSON.stringify([process.execPath, ...rest.slice(1)])};\n${rest[0] ?? ''}`, { mode: 0o600 });
      invocation.args = [file];
    } else if (entry && !entry.startsWith('-') && rest.length) {
      temporary = mkdtempSync(join(process.env.RELAY_NATIVE_TEMP_DIR ?? tmpdir(), 'node-'));
      const preload = join(temporary, 'argv.cjs');
      writeFileSync(preload, `process.argv.push(...${JSON.stringify(rest)});`, { mode: 0o600 });
      invocation.args = ['--require', preload, entry];
    }
  }
  try {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
      });
      let stdout = '', stderr = '';
      // Discovery is bounded, including a malformed runtime that floods output.
      const limit = 16 * 1024 * 1024;
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { if (!options.discardStdout) stdout = (stdout + chunk).slice(-limit); });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-limit); });
      child.once('error', error => reject(Object.assign(error, { code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1 })));
      child.once('close', code => done({ code: code ?? 1, stdout, stderr }));
    });
    if (result.code !== 0 && !options.allowFailure) {
      throw Object.assign(new Error((result.stdout + result.stderr).trim() || `${argv[0]} exited with code ${result.code}.`), { code: result.code });
    }
    return result;
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
}

/** The caller supervises one Node root, retaining existing streaming, cancellation and exit proof. */
export async function runNativeScript(script: string, options: Parameters<typeof superviseLocalProcess>[2]) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-native-'));
  const file = join(directory, 'run.mjs');
  try {
    writeFileSync(file, `import { relayRun } from ${JSON.stringify(import.meta.url)};\ntry {\n${script}\n} catch (error) { console.error(error.message); process.exitCode = Number.isInteger(error.code) && error.code > 0 && error.code <= 255 ? error.code : 1; }\n`, { mode: 0o600 });
    return await superviseLocalProcess(process.execPath, [file], { ...options, env: { ...options?.env, RELAY_NATIVE_TEMP_DIR: directory } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
