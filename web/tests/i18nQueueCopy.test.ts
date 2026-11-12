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
const HAN = /\p{Script=Han}/u;
const ENGLISH_WORD = /[A-Za-z]{3,}/;

function queue(locale: string): Array<[string, string]> {
  const tree = JSON.parse(readFileSync(resolve(`web/src/i18n/locales/${locale}/translation.json`), "utf8")) as Tree;
  return flatten(tree.queue as Tree);
}

/* The queue dock labels its rows in both languages, so an English-only key
   showed "Steer" in the Chinese dock. Every action here must be translated. */
describe("Queue copy", () => {
  const english = queue("en");
  const chinese = queue("zh-CN");
  const chineseKeys = new Set(chinese.map(([key]) => key));

  it("gives every English label a Simplified Chinese counterpart", () => {
    const missing = english
      .filter(([key]) => !PLURAL_SUFFIX.test(key) && !chineseKeys.has(key))
      .map(([key]) => key);
    assert.deepEqual(missing, []);
  });

  it("leaves no English-only label in Simplified Chinese", () => {
    const untranslated = chinese
      .filter(([, value]) => !HAN.test(value) || ENGLISH_WORD.test(value.replace(/\{\{[^}]*\}\}/g, "")))
      .map(([key, value]) => `${key}: ${value}`);
    assert.deepEqual(untranslated, []);
  });
});
