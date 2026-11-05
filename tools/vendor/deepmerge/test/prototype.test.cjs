const assert = require('node:assert/strict');
const test = require('node:test');
const merge = require('deepmerge');

test('untrusted target keys cannot poison the result prototype', () => {
  const target = JSON.parse('{"__proto__":{"isAdmin":true},"safe":1}');
  const result = merge(target, { ok: true });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.isAdmin, undefined);
  assert.equal(result.safe, 1);
  assert.equal(result.ok, true);
});

test('a source merged into a null-prototype target cannot poison the result', () => {
  const result = merge(Object.create(null), JSON.parse('{"__proto__":{"isAdmin":true}}'));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.isAdmin, undefined);
});

test('nested clones and array entries cannot inherit attacker privileges', () => {
  const input = JSON.parse('{"nested":{"__proto__":{"isAdmin":true}},"items":[{"__proto__":{"isAdmin":true}}]}');
  const result = merge(input, {});
  for (const value of [result.nested, result.items[0]]) {
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.equal(value.isAdmin, undefined);
  }
});

test('ordinary recursive merging, symbols, arrays, and custom merges still work', () => {
  const symbol = Symbol('metadata');
  assert.deepEqual(merge({ a: { x: 1 }, list: [1], [symbol]: 'kept' }, { a: { y: 2 }, list: [2] }), {
    a: { x: 1, y: 2 }, list: [1, 2], [symbol]: 'kept',
  });
  assert.deepEqual(merge.all([{ a: 1 }, { b: 2 }]), { a: 1, b: 2 });
  assert.deepEqual(merge({ a: [1] }, { a: [2] }, { customMerge: () => (_left, right) => right }), { a: [2] });
});
