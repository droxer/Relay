import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LANDING_HERO_SHOT,
  LANDING_PRINCIPLES,
  LANDING_STEPS,
  LANDING_TOUR,
  RELAY_GITHUB_URL,
  RELAY_CLONE_COMMAND,
  landingCtas,
  landingShotSrc,
} from "../src/lib/landing.js";

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "web", "src", "styles", "tokens", "palette.css"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("unable to locate repository root");
    dir = parent;
  }
}

const webRoot = path.join(findRepoRoot(), "web");

describe("landingShotSrc", () => {
  it("serves the localized screenshot for Simplified Chinese", () => {
    assert.equal(landingShotSrc("threads", "zh-CN"), "/landing/threads-zh-CN.webp");
  });

  it("falls back to the English screenshot for any other language", () => {
    assert.equal(landingShotSrc("threads", "en"), "/landing/threads.webp");
    assert.equal(landingShotSrc("teams", undefined), "/landing/teams.webp");
  });

  it("ships every screenshot the page asks for, in both languages", () => {
    const shots = [LANDING_HERO_SHOT, ...LANDING_TOUR.map((item) => item.shot)];
    for (const shot of shots) {
      for (const language of ["en", "zh-CN"]) {
        const file = path.join(webRoot, "public", landingShotSrc(shot, language));
        assert.ok(existsSync(file), `missing ${file}`);
      }
    }
  });
});

describe("landingCtas", () => {
  it("leads with request access when the waitlist takes requests", () => {
    assert.deepEqual(landingCtas(true), {
      primary: { href: "/waitlist", labelKey: "landing.request_access" },
      secondary: { href: "/login", labelKey: "landing.sign_in" },
    });
  });

  it("offers only sign in when the waitlist is off or unknown", () => {
    for (const enabled of [false, null]) {
      assert.deepEqual(landingCtas(enabled), {
        primary: { href: "/login", labelKey: "landing.sign_in" },
        secondary: null,
      });
    }
  });
});

describe("landing copy", () => {
  it("has every key the page renders in both locales", () => {
    const keys = [
      ...LANDING_STEPS.flatMap((step) => [step.titleKey, step.bodyKey]),
      ...LANDING_TOUR.flatMap((item) => [item.titleKey, item.bodyKey, item.altKey]),
      ...LANDING_PRINCIPLES.flatMap((item) => [item.titleKey, item.bodyKey]),
    ];
    for (const locale of ["en", "zh-CN"]) {
      const file = path.join(webRoot, "src", "i18n", "locales", locale, "translation.json");
      const landing = JSON.parse(readFileSync(file, "utf8")).landing as Record<string, string>;
      for (const key of keys) {
        const leaf = key.replace(/^landing\./, "");
        assert.equal(typeof landing[leaf], "string", `${locale} is missing ${key}`);
      }
    }
  });
});

describe("open source links", () => {
  it("points at the public repository over https", () => {
    assert.equal(RELAY_GITHUB_URL, "https://github.com/droxer/Relay");
    assert.equal(RELAY_CLONE_COMMAND, "git clone https://github.com/droxer/Relay.git");
  });
});
