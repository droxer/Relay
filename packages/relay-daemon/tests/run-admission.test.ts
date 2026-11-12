import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeLimits, admissionWaitReason } from "../src/run-admission.js";

test("runtime limit leaves other runtimes available while respecting the Computer cap", () => {
  const runs = [{ agent: "codex" as const }];
  assert.equal(admissionWaitReason(runs, "codex", 3, { codex: 1 }), "runtime-capacity");
  assert.equal(admissionWaitReason(runs, "claude", 3, { codex: 1 }), undefined);
  assert.equal(admissionWaitReason(runs, "claude", 1, {}), "computer-capacity");
  assert.equal(admissionWaitReason([], "codex", 3, {}), undefined);
});

test("runtime limits are explicit positive integers for known runtimes", () => {
  assert.deepEqual(parseRuntimeLimits(undefined), {});
  assert.deepEqual(parseRuntimeLimits('{"codex":2,"claude":1}'), { codex: 2, claude: 1 });
  for (const raw of ['[]', 'null', '1', '{', '{"unknown":1}', '{"codex":0}',
    '{"codex":-1}', '{"codex":1.5}', '{"codex":"2"}', '{"codex":true}']) {
    assert.throws(() => parseRuntimeLimits(raw), /RELAY_DAEMON_RUNTIME_LIMITS/);
  }
});

test('resource budgets reject invalid values instead of silently reverting to defaults', async () => {
  const { resourceLimit } = await import('../src/run-admission.js');
  assert.equal(resourceLimit('GUESTS', undefined, 5), 5);
  assert.equal(resourceLimit('GUESTS', '2', 5), 2);
  for (const value of ['', '0', '-1', '1.5', 'no', Infinity, NaN]) {
    assert.throws(() => resourceLimit('GUESTS', value, 5), /GUESTS/);
  }
});
