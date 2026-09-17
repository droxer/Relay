import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [[prefix + key, value] as [string, string]] : flatten(value, `${prefix}${key}.`),
  );
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
/* A count followed by a plural noun, optionally through one modifier:
   "{{count}} computers", "{{count}} deleted computers". */
const COUNTED_NOUN = /\{\{count\}\}\s+(?:\p{L}+\s+)?\p{L}+s\b/u;

describe("English plural forms", () => {
  // "{{count}} computers." rendered "1 computers." on the dashboard: i18next
  // only picks a singular when the key has a `_one` form to pick.
  it("gives every counted noun a singular form", () => {
    const english = JSON.parse(readFileSync(resolve("web/src/i18n/locales/en/translation.json"), "utf8")) as Tree;
    const offenders = flatten(english)
      .filter(([key, value]) => !PLURAL_SUFFIX.test(key) && COUNTED_NOUN.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    assert.deepEqual(offenders, []);
  });
});
