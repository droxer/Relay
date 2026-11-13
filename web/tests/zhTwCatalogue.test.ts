import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const dir = path.join(process.cwd(), "web", "src", "i18n", "locales");
const load = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(dir, locale, "translation.json"), "utf8"));

function flatten(value: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === "string") out.set(prefix, value);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      for (const [k, v] of flatten(child, prefix ? `${prefix}.${key}` : key)) out.set(k, v);
    }
  }
  return out;
}

const placeholders = (text: string) => (text.match(/\{\{[^}]*\}\}/g) ?? []).sort();

describe("zh-TW catalogue", () => {
  const cn = flatten(load("zh-CN"));
  const tw = flatten(load("zh-TW"));

  it("has exactly the keys of zh-CN", () => {
    assert.deepEqual([...tw.keys()].sort(), [...cn.keys()].sort());
  });

  it("keeps every interpolation placeholder", () => {
    for (const [key, text] of cn) assert.deepEqual(placeholders(tw.get(key) ?? ""), placeholders(text), key);
  });
});
