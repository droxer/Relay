import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("the web skill contract exposes scoped assignments and stable revisions", async () => {
  const types = await readFile(resolve("web/src/types.ts"), "utf8");
  assert.match(types, /export interface SkillAssignment/);
  assert.match(types, /stableRevisionId: string/);
  assert.match(types, /assignments: SkillAssignment\[\]/);
});

test("the share drawer assigns scopes instead of expanding teams into agent grants", async () => {
  const source = await readFile(resolve("web/src/components/ShareSkillDrawer.tsx"), "utf8");
  assert.match(source, /assignSkill/);
  assert.match(source, /targetType: "employee"/);
  assert.match(source, /targetType: "team"/);
  assert.match(source, /targetType: "agent"/);
  assert.doesNotMatch(source, /team\.memberAgentIds\.filter/);
});
