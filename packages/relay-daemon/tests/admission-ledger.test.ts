import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdmissionLedger } from '../src/admission-ledger.js';

test('bounded admission cache preserves exact fences across eviction and restart', t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-admissions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = new AdmissionLedger(root, 2);
  for (let i = 0; i < 20; i++) ledger.add(`command-${i}`);
  for (let i = 0; i < 20; i++) assert.equal(ledger.has(`command-${i}`), true);
  assert.equal(ledger.has('never-executed'), false);
  assert.ok(ledger.cachedCount <= 2);
  const restarted = new AdmissionLedger(root, 2);
  assert.equal(restarted.has('command-0'), true);
  const size = () => readdirSync(root).reduce((sum, name) => sum + statSync(join(root, name)).size, 0);
  assert.equal(size(), 20 * 32, 'fences retain only SHA-256 identities');
  restarted.add('command-0');
  assert.equal(size(), 20 * 32, 'duplicate admission must not grow the ledger');
});
