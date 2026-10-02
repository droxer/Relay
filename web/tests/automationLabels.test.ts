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

/* The feature is "Automations" wherever a reader sees it; `routine*` survives
   only as a storage and wire name. "routine updates" on the login page is
   plain English, not the feature. */
const RETIRED = /routine|例行/i;
const PLAIN_ENGLISH = new Set(["login.do_handoff"]);

describe("Automation labels", () => {
  for (const locale of ["en", "zh-CN"]) {
    it(`never says routine in ${locale}`, () => {
      const tree = JSON.parse(readFileSync(resolve(`web/src/i18n/locales/${locale}/translation.json`), "utf8")) as Tree;
      const offenders = flatten(tree)
        .filter(([key, value]) => !PLAIN_ENGLISH.has(key) && RETIRED.test(value))
        .map(([key, value]) => `${key}: ${value}`);
      assert.deepEqual(offenders, []);
    });
  }
});
