import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";

const webRoot = resolve("web");
const readWeb = (path: string) => readFileSync(resolve(webRoot, path), "utf8");

describe("icon system regressions", () => {
  it("uses the Pi Coding Agent badge rather than the unrelated Inflection mark", () => {
    const source = readWeb("src/components/AgentMark.tsx");

    assert.match(source, /pi\.dev\/favicon\.svg/);
    assert.match(source, /M4\.959 4\.959H15\.521V12/);
    assert.doesNotMatch(source, /Inflection|inflection\.svg/i);
  });

  it("draws a distinct vector glyph for every supported chat provider", () => {
    const source = readWeb("src/components/admin/ChannelPrimitives.tsx");

    for (const provider of ["discord", "telegram", "lark"]) {
      assert.match(source, new RegExp(`provider === "${provider}"`));
    }
    assert.doesNotMatch(source, /providerLabel\(provider\)\.charAt\(0\)/);
  });

  it("keeps in-app Relay marks decorative and on the shared glyph scale", () => {
    const mark = readWeb("src/components/RelayMark.tsx");
    assert.match(mark, /size\?: number/);
    assert.match(mark, /aria-hidden="true"/);
    assert.match(mark, /focusable="false"/);
    assert.doesNotMatch(mark, /role="img"|aria-label=/);
    assert.doesNotMatch(mark, /width\?: number|height\?: number/);

    for (const path of [
      "src/components/AuthCanvas.tsx",
      "src/components/SideNav.tsx",
      "src/components/TranscriptEmpty.tsx",
      "src/components/ThreadsView.tsx",
      "src/components/admin/AdminAuthScreens.tsx",
    ]) {
      const source = readWeb(path);
      const calls = [...source.matchAll(/<RelayMark\b[^>]*\/>/g)];
      assert.ok(calls.length > 0, `${path} must render a RelayMark`);
      for (const call of calls) {
        assert.match(call[0], /size=\{ICON\.\w+\}/, `${path}: ${call[0]}`);
        assert.doesNotMatch(call[0], /\b(?:width|height)=/, `${path}: ${call[0]}`);
      }
    }

    const transcript = readWeb("src/components/TranscriptEmpty.tsx");
    assert.match(transcript, /<ActionPrompt size=\{ICON\.xs\}/);
    assert.doesNotMatch(transcript, /<ActionPrompt[^>]*(?:width|height)=/);
  });

  it("publishes one deterministic favicon and a raster Apple touch icon", () => {
    const layout = readWeb("src/app/layout.tsx");
    const iconEntries = layout.match(/icon:\s*\[([\s\S]*?)\],/)?.[1] ?? "";

    assert.equal([...iconEntries.matchAll(/\burl:/g)].length, 1);
    assert.match(iconEntries, /url:\s*"\/favicon\.svg"/);
    assert.match(iconEntries, /sizes:\s*"any"/);
    assert.match(
      layout,
      /apple:\s*\[\{\s*url:\s*"\/apple-touch-icon\.png",\s*sizes:\s*"180x180",\s*type:\s*"image\/png"\s*\}\]/,
    );

    const pngPath = resolve(webRoot, "public/apple-touch-icon.png");
    assert.ok(existsSync(pngPath), "public/apple-touch-icon.png is missing");
    const png = readFileSync(pngPath);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 180);
    assert.equal(png.readUInt32BE(20), 180);
  });

  it("uses the large-stroke tier for every hero-sized Lucide illustration", () => {
    const source = readWeb("src/components/ComputerPage.tsx");

    assert.match(
      source,
      /<AdminNode size=\{ICON\.hero\} strokeWidth=\{ICON_STROKE_LARGE\} aria-hidden="true"/,
    );
  });

  it("keeps repository and web brand assets canonical", () => {
    assert.equal(
      readFileSync(resolve("assets/brand/relay-logo.svg"), "utf8"),
      readWeb("public/brand/relay-logo.svg"),
    );
    assert.equal(
      readFileSync(resolve("assets/brand/relay-mark.svg"), "utf8"),
      readWeb("public/brand/relay-mark.svg"),
    );
  });
});
