import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("root layout bootstrap script", () => {
  it("executes the theme bootstrap while parsing without rerunning it on the client", () => {
    const layout = readFileSync("web/src/app/layout.tsx", "utf8");
    const inlineScript = readFileSync("web/src/components/InlineScript.tsx", "utf8");

    assert.match(layout, /<InlineScript html=\{themeScript\}\s*\/>/);
    // Executable inline code goes through InlineScript; a JSON-LD block is
    // inert data, so it may stay a plain <script type="application/ld+json">.
    assert.doesNotMatch(layout, /<script(?![^>]*type="application\/ld\+json")(?:\s|>)/);
    assert.match(inlineScript, /type=\{typeof window === ["']undefined["'] \? ["']text\/javascript["'] : ["']text\/plain["']\}/);
    assert.match(inlineScript, /suppressHydrationWarning/);
  });
});
