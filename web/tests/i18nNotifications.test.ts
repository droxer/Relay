import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createInstance } from "i18next";
import { NOTIFICATION_KINDS } from "../src/api-client/notifications.js";

type Tree = { [key: string]: string | Tree };

function catalogue(locale: string): Tree {
  return JSON.parse(readFileSync(`web/src/i18n/locales/${locale}/translation.json`, "utf8")) as Tree;
}

function flatten(tree: Tree, prefix = "notifications."): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [[prefix + key, value] as [string, string]] : flatten(value, `${prefix}${key}.`),
  );
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{([^}]+)\}\}/g)].map((match) => match[1]).sort();
}

for (const locale of ["en", "zh-CN", "zh-TW"]) describe(`Notification copy (${locale})`, () => {
  it("renders a label and description for every notification setting without fallback", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: locale, fallbackLng: false, resources: { [locale]: { translation: catalogue(locale) } } });
    for (const kind of NOTIFICATION_KINDS) {
      for (const suffix of ["", "_sub"]) {
        const key = `notifications.kind.${kind}${suffix}`;
        assert.ok(i18n.exists(key), `${locale}: missing ${key}`);
        const rendered = i18n.t(key);
        assert.notEqual(rendered, key);
        assert.ok(rendered.trim());
        if (locale !== "en") assert.match(rendered, /\p{Script=Han}/u);
      }
    }
  });

  it("provides all inbox, desktop and settings copy with matching placeholders", () => {
    const translated = new Map(flatten(catalogue(locale).notifications as Tree));
    for (const [key, english] of flatten(catalogue("en").notifications as Tree)) {
      const value = translated.get(key);
      assert.ok(value, `${locale}: missing ${key}`);
      assert.deepEqual(placeholders(value), placeholders(english), `${locale}: ${key}`);
    }
  });
});
