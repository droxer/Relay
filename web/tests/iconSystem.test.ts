import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import sharp from "sharp";

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

  it("ships a favicon an XML parser accepts, plus /favicon.ico for clients that skip the page", () => {
    // A browser decodes an SVG icon as strict XML; "--" inside a comment (say,
    // naming a CSS custom property) is a parse error and the tab shows no icon.
    const svg = readWeb("public/favicon.svg");
    for (const [, comment] of svg.matchAll(/<!--([\s\S]*?)-->/g)) {
      assert.doesNotMatch(comment, /--/, "favicon.svg comment contains '--'");
    }

    const ico = readFileSync(resolve(webRoot, "public/favicon.ico"));
    assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
    assert.ok(ico.readUInt16LE(4) > 0, "favicon.ico holds no images");
  });

  it("supplies opaque OS icons with a consistent canvas and safe Android artwork", async () => {
    const favicon = readWeb("public/favicon.svg");
    const canvas = favicon.match(/<rect[^>]*fill="(#[0-9a-f]{6})"/)?.[1];
    assert.ok(canvas);
    const background = [1, 3, 5].map(offset => parseInt(canvas.slice(offset, offset + 2), 16));
    for (const [file, size] of [["apple-touch-icon.png", 180], ["icons/icon-maskable-512.png", 512]] as const) {
      const { data, info } = await sharp(resolve(webRoot, "public", file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, size);
      assert.equal(info.height, size);
      let artworkPixels = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const offset = (y * size + x) * 4;
          assert.equal(data[offset + 3], 255, `${file} must be opaque`);
          const difference = background.reduce((sum, channel, index) => sum + Math.abs(data[offset + index] - channel), 0);
          if (difference <= 24) continue; // Ignore antialiasing at the edge.
          artworkPixels++;
          if (file.includes("maskable")) {
            assert.ok(Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) <= size * 0.4,
              "Android may crop artwork outside its safe circle");
          }
        }
      }
      assert.ok(artworkPixels > size * size * 0.1, `${file} mark is too small or missing`);
      assert.deepEqual([...data.subarray(0, 3)], background);
    }
    const manifest = JSON.parse(readWeb("public/manifest.webmanifest"));
    assert.equal(manifest.background_color, canvas);
    assert.equal(manifest.theme_color, canvas);
    for (const icon of manifest.icons) {
      const metadata = await sharp(resolve(webRoot, "public", icon.src.slice(1))).metadata();
      assert.equal(`${metadata.width}x${metadata.height}`, icon.sizes);
    }
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
