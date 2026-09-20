// Package only compiled client code: no repository, .env files, or credentials.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

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
  cpSync(resolve('node_modules/smol-toml'), join(staging, 'node_modules/smol-toml'), { recursive: true });
  mkdirSync(resolve('backend/relay/computer'), { recursive: true });
  execFileSync('tar', ['-czf', output + '.tmp', '-C', staging, 'node_modules']);
  renameSync(output + '.tmp', output);
  console.log(`Computer installer bundle: ${output}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
