/**
 * Every install unpacks `releases/<sha256>` and may unpack `runtimes/node-v…`
 * under the Relay root (`~/.local/share/relay`, `%LOCALAPPDATA%\Relay`); the
 * installer scripts never remove them. After a successful install, drop the
 * ones nothing runs: no installed service names them, they are not this
 * install's own, and they are not among the newest few — which covers a
 * daemon someone started by hand from an older release.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

export const KEEP_NEWEST_UNREFERENCED = 2;
const RELEASE_NAME = /^[a-f0-9]{64}$/;
const RUNTIME_NAME = /^node-v\d+\.\d+\.\d+-[a-z0-9]+-[a-z0-9]+$/;

export interface InstallEntry { path: string; mtimeMs: number }

/** The release or runtime directory under `root` that `file` lives in, if any. */
export function installDirectoryOf(root: string, file: string): string | undefined {
  const offset = relative(root, file);
  if (!offset || offset.startsWith('..') || isAbsolute(offset)) return undefined;
  const [kind, name] = offset.split(/[\\/]/);
  if (!name) return undefined;
  if (kind === 'releases' && RELEASE_NAME.test(name)) return join(root, kind, name);
  if (kind === 'runtimes' && RUNTIME_NAME.test(name)) return join(root, kind, name);
  return undefined;
}

/** The Relay root an installer runs from: `<root>/releases/<sha>/node_modules/relay-daemon/dist/install.js`. */
export function installRootOf(installScript: string): string | undefined {
  const release = dirname(dirname(dirname(dirname(installScript))));
  const releases = dirname(release);
  return basename(releases) === 'releases' && RELEASE_NAME.test(basename(release)) ? dirname(releases) : undefined;
}

/** Entries to delete: neither kept explicitly nor among the newest unreferenced ones. */
export function staleInstallEntries(entries: InstallEntry[], keep: Set<string>, keepNewest = KEEP_NEWEST_UNREFERENCED): string[] {
  return entries
    .filter(entry => !keep.has(entry.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(keepNewest)
    .map(entry => entry.path);
}

function entriesOf(directory: string, name: RegExp): InstallEntry[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && name.test(entry.name))
      .map(entry => ({ path: join(directory, entry.name), mtimeMs: statSync(join(directory, entry.name)).mtimeMs }));
  } catch {
    return [];
  }
}

/** Removes unused releases and runtimes; `inUse` are files services or this process run. Returns what it removed. */
export function pruneInstallDirectories(root: string, inUse: string[], warn: (message: string) => void): string[] {
  const keep = new Set(inUse.flatMap(file => installDirectoryOf(root, file) ?? []));
  const stale = [
    ...staleInstallEntries(entriesOf(join(root, 'releases'), RELEASE_NAME), keep),
    ...staleInstallEntries(entriesOf(join(root, 'runtimes'), RUNTIME_NAME), keep),
  ];
  return stale.filter(path => {
    try { rmSync(path, { recursive: true, force: true }); return true; } catch (error) {
      warn(`Could not remove an old Relay install at ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  });
}
