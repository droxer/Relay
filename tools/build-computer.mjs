// Package only compiled client code: no repository, .env files, or credentials.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// What the packaged daemon advertises; the backend checks it at startup so a
// stale bundle cannot silently leave every updated computer reading outdated.
const { DAEMON_ADVERTISED_CAPABILITIES } = await import(pathToFileURL(resolve('packages/relay-daemon/dist/capabilities.js')).href);
const staging = mkdtempSync(join(tmpdir(), 'relay-computer-'));
const output = resolve('backend/relay/computer/daemon.tar.gz');
try {
  for (const name of ['relay-core', 'relay-daemon']) {
    const dest = join(staging, 'node_modules', name);
    mkdirSync(dest, { recursive: true });
    cpSync(`packages/${name}/dist`, join(dest, 'dist'), { recursive: true });
    const manifest = JSON.parse(readFileSync(`packages/${name}/package.json`, 'utf8'));
    // BoxLite is not shipped; direct execution uses the bundled TOML parser.
    if (manifest.dependencies) delete manifest.dependencies["@boxlite-ai/boxlite"];
    writeFileSync(join(dest, 'package.json'), JSON.stringify(manifest));
  }
  writeFileSync(
    join(staging, 'node_modules/relay-daemon/capabilities.json'),
    JSON.stringify({ capabilities: [...DAEMON_ADVERTISED_CAPABILITIES].sort() }),
  );
  cpSync(resolve('node_modules/smol-toml'), join(staging, 'node_modules/smol-toml'), { recursive: true });
  mkdirSync(resolve('backend/relay/computer'), { recursive: true });
  execFileSync('tar', ['-czf', output + '.tmp', '-C', staging, 'node_modules']);
  renameSync(output + '.tmp', output);
  console.log(`Computer installer bundle: ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
