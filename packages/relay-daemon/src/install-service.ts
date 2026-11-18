import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bootoutLaunchdService, type InstalledService, type RelayBrand } from './control.js';
import { stopService, type ServiceRunner } from './installed-computers.js';
import { launchdBootstrapError } from './install-notices.js';
import { writeRuntimeProfile, type RuntimeProfile } from './runtime-profile.js';
import { requestUpdateStartup } from './update-startup.js';
import { encodeTaskFile, registerWindowsTask, windowsTaskState } from './windows-service.js';

interface ServiceState { running: boolean; enabled: boolean }

function readServiceState(platform: string, uid: number, service: InstalledService, runner: ServiceRunner): ServiceState {
  const unknown = () => new Error(`Could not determine the state of ${service.name}. Check the service and retry.`);
  if (platform === 'darwin') {
    const domain = `gui/${uid}`;
    const loaded = runner.run('launchctl', ['print', `${domain}/${service.name}`]).status;
    const disabled = runner.run('launchctl', ['print-disabled', domain]);
    if ((loaded !== 0 && loaded !== 113) || disabled.status !== 0) throw unknown();
    const setting = disabled.stdout.split('\n').find(line => line.trimStart().startsWith(`"${service.name}" =>`));
    return { running: loaded === 0, enabled: !/=>\s*(true|disabled)\b/.test(setting ?? '') };
  }
  if (platform === 'win32') {
    const state = windowsTaskState(runner, service.name);
    if (state === 'Unknown') throw unknown();
    return { running: state === 'Running' || state === 'Queued', enabled: state !== 'Disabled' };
  }
  const unit = `${service.name}.service`;
  const active = runner.run('systemctl', ['--user', 'is-active', unit]).stdout.trim();
  const enabled = runner.run('systemctl', ['--user', 'is-enabled', unit]).stdout.trim();
  if (!['active', 'inactive', 'failed'].includes(active) || !['enabled', 'disabled'].includes(enabled)) throw unknown();
  return { running: active === 'active', enabled: enabled === 'enabled' };
}

export function activateInstalledService(
  platform: string, uid: number, service: InstalledService, runner: ServiceRunner, brand: RelayBrand,
  state: ServiceState = { running: true, enabled: true },
): void {
  const run = (command: string, args: string[], message: string): void => {
    if (runner.run(command, args, { inherit: true }).status !== 0) throw new Error(message);
  };
  if (platform === 'darwin') {
    const domain = `gui/${uid}`;
    const target = `${domain}/${service.name}`;
    if (!bootoutLaunchdService(runner, target)) throw new Error(`The running ${brand.product} service ${service.name} did not stop; run the installer again.`);
    if (state.running || state.enabled) run('launchctl', ['enable', target], `Could not enable ${service.name}.`);
    if (state.running) run('launchctl', ['bootstrap', domain, service.file], launchdBootstrapError(process.env, brand.product));
    if (!state.enabled) run('launchctl', ['disable', target], `Could not disable ${service.name}.`);
  } else if (platform === 'win32') {
    registerWindowsTask(runner, service.name, service.file, state.running);
    if (!state.enabled) run('schtasks', ['/Change', '/TN', service.name, '/DISABLE'], `Could not disable ${service.name}.`);
  } else {
    const unit = `${service.name}.service`;
    run('systemctl', ['--user', 'daemon-reload'], 'Could not reload systemd user services.');
    run('systemctl', ['--user', state.enabled ? 'enable' : 'disable', unit], `Could not set the startup state of ${unit}.`);
    if (state.running) run('systemctl', ['--user', 'restart', unit], `Could not restart ${unit}.`);
  }
}

function writePrivateFile(path: string, content: string | Buffer): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function writeServiceDefinition(platform: string, file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writePrivateFile(file, platform === 'win32' ? encodeTaskFile(content) : content);
}

export async function updateInstalledService(options: {
  platform: string; uid: number; service: InstalledService; runner: ServiceRunner; brand: RelayBrand;
  stateDir: string; profile?: RuntimeProfile; definition(attempt: string): string;
}): Promise<void> {
  const { platform, uid, service, runner, brand, stateDir, profile } = options;
  const previousState = readServiceState(platform, uid, service, runner);
  const previousDefinition = readFileSync(service.file);
  const profilePath = join(stateDir, 'runtime-profile.json');
  let previousProfile: Buffer | undefined;
  if (profile) {
    try { previousProfile = readFileSync(profilePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const startup = requestUpdateStartup(stateDir);
  const interrupted = new AbortController();
  const cancel = () => interrupted.abort(new Error('Update interrupted.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let profileChanged = false;
  let serviceChanged = false;
  try {
    const definition = options.definition(startup.attempt);
    if (profile) {
      writeRuntimeProfile(stateDir, profile);
      profileChanged = true;
    }
    writeServiceDefinition(platform, service.file, definition);
    serviceChanged = true;
    activateInstalledService(platform, uid, service, runner, brand);
    const deadline = AbortSignal.timeout(120_000);
    await startup.wait(AbortSignal.any([deadline, interrupted.signal])).catch(error => {
      if (deadline.aborted) throw new Error('The replacement daemon did not register with Relay within two minutes.');
      if (interrupted.signal.aborted) throw interrupted.signal.reason;
      throw error;
    });
  } catch (error) {
    if (!profileChanged && !serviceChanged) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const rollbackErrors: unknown[] = [];
    if (serviceChanged) {
      try { stopService(platform, uid, service, runner); }
      catch (error) { rollbackErrors.push(error); }
    }
    if (profileChanged) {
      try {
        if (previousProfile) writePrivateFile(profilePath, previousProfile);
        else rmSync(profilePath, { force: true });
      } catch (error) { rollbackErrors.push(error); }
    }
    if (serviceChanged) {
      try {
        writePrivateFile(service.file, previousDefinition);
        activateInstalledService(platform, uid, service, runner, brand, previousState);
      } catch (error) { rollbackErrors.push(error); }
    }
    if (rollbackErrors.length) {
      throw new Error(`${detail} Could not fully restore the previous service. Check Relay status and logs. ${rollbackErrors.map(String).join(' ')}`);
    }
    throw new Error(`${detail} Restored the previous Relay service.`);
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    startup.release();
  }
}
