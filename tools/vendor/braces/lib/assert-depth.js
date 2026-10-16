'use strict';

// Relay patch for CVE-2026-93687 (GHSA-vfj7-8cjw-p6xm), after micromatch/braces#88.
// The compile/expand/stringify walkers recurse once per nesting level, so a
// deep AST exhausts the call stack. Walk iteratively first and refuse any AST
// that is deeper than MAX_DEPTH or contains a cycle.

const MAX_DEPTH = 128;

const assertDepth = ast => {
  const pending = [[ast, 0, false]];
  const seen = new WeakSet();
  while (pending.length) {
    const [node, depth, exit] = pending.pop();
    if (exit) {
      seen.delete(node);
      continue;
    }
    if (depth > MAX_DEPTH) {
      throw new SyntaxError(`Brace AST exceeds safe depth of ${MAX_DEPTH}`);
    }
    if (seen.has(node)) {
      throw new SyntaxError('Brace AST must be an acyclic tree');
    }
    seen.add(node);
    pending.push([node, depth, true]);
    if (node.nodes) {
      for (const child of node.nodes) pending.push([child, depth + 1, false]);
    }
  }
};

module.exports = assertDepth;
module.exports.MAX_DEPTH = MAX_DEPTH;
