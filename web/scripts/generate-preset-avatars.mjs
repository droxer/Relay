#!/usr/bin/env node
/**
 * Regenerates the preset profile images under web/public/avatars/.
 *
 * The SVGs are committed, so this only runs when the preset set changes. The
 * DiceBear packages are deliberately not project dependencies — install them
 * without saving first:
 *
 *   npm install --no-save @dicebear/core@10.7.0 @dicebear/styles@10.6.0
 *   node web/scripts/generate-preset-avatars.mjs
 *
 * The preset ids here must match web/src/lib/presetAvatars.ts and
 * backend/relay/core/preset_avatars.py; tests on both sides check the files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Avatar, Style } from "@dicebear/core";
import lorelei from "@dicebear/styles/lorelei.json" with { type: "json" };
import personas from "@dicebear/styles/personas.json" with { type: "json" };
import pixelArt from "@dicebear/styles/pixel-art.json" with { type: "json" };
import shapeGrid from "@dicebear/styles/shape-grid.json" with { type: "json" };

const OUTPUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "avatars");

// Soft backgrounds so every agent avatar still reads as a filled chip at 16px.
// No lavender or periwinkle: purple is retired from Relay (brandIdentity.test.ts).
const AGENT_BACKGROUNDS = ["b6e3f4", "e3e1da", "d4e4e8", "ffd5dc", "ffdfbf", "c7f0d8"];

/* The violet arc brandIdentity.test.ts refuses: OKLCH hue 280–340 with real
   chroma. Kept in step with that test, which scans these files. */
function isPurple(hex) {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
  if (Math.max(...channels) - Math.min(...channels) <= 24) return false;
  const [r, g, b] = channels.map((c) => {
    const unit = c / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return hue >= 280 && hue <= 340;
}

/** The grey with the same perceived lightness, for a purple literal drawn
    into a style's artwork (Personas inks its outlines #1B0640). */
function greyFor(hex) {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
  const level = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  return `#${level.toString(16).padStart(2, "0").repeat(3)}`;
}

/** A copy of a DiceBear style that draws no purple: palettes lose their
    violet entries, and purple literals in the artwork turn grey. */
function withoutPurple(source) {
  // Palettes first, so a violet choice is dropped rather than greyed.
  const colors = Object.fromEntries(
    Object.entries(source.colors ?? {}).map(([part, spec]) => [
      part,
      Array.isArray(spec.values) ? { ...spec, values: spec.values.filter((hex) => !isPurple(hex)) } : spec,
    ]),
  );
  return JSON.parse(
    JSON.stringify({ ...source, colors }).replace(/#[0-9a-fA-F]{6}\b/g, (hex) => (isPurple(hex) ? greyFor(hex) : hex)),
  );
}

const AGENT_STYLES = [
  {
    name: "lorelei",
    definition: lorelei,
    seeds: [
      "aria", "juniper", "sage", "wren", "hazel", "iris", "rowan", "willow",
      "clover", "ember", "lark", "maple", "robin", "sparrow", "violet", "fern",
    ],
  },
  {
    name: "pixel-art",
    definition: pixelArt,
    seeds: [
      "arcade", "joystick", "sprite", "bitmap", "chiptune", "cartridge", "quest", "level",
      "combo", "token", "boss", "portal", "respawn", "glitch", "retro", "byte",
    ],
  },
  {
    name: "personas",
    definition: personas,
    seeds: [
      "ada", "alan", "grace", "linus", "margaret", "dennis", "barbara", "ken",
      "radia", "tim", "frances", "guido", "hedy", "bjarne", "katherine", "yukihiro",
    ],
  },
];
const TEAM_SEEDS = [
  "atlas", "harbor", "summit", "meadow", "comet", "delta",
  "orbit", "ember", "tide", "grove", "prism", "nova",
];

function writeSet(kind, style, seeds, optionsFor) {
  const directory = join(OUTPUT_ROOT, kind);
  mkdirSync(directory, { recursive: true });
  seeds.forEach((seed, index) => {
    const id = `${style.name}-${String(index + 1).padStart(2, "0")}`;
    const svg = new Avatar(new Style(withoutPurple(style.definition)), { seed, ...optionsFor(index) }).toString();
    writeFileSync(join(directory, `${id}.svg`), `${svg}\n`);
  });
}

for (const { name, definition, seeds } of AGENT_STYLES) {
  writeSet("agents", { name, definition }, seeds, (index) => ({
    backgroundColor: [AGENT_BACKGROUNDS[index % AGENT_BACKGROUNDS.length]],
  }));
}
/* Shape Grid's "plus" is drawn as a four-point star: the stock sparkle that
   stands for "AI magic". A team tile keeps the plain geometry. */
const { plus: _sparkle, ...teamShapes } = shapeGrid.components.shape.variants;
const shapeGridWithoutSparkle = {
  ...shapeGrid,
  components: {
    ...shapeGrid.components,
    shape: { ...shapeGrid.components.shape, variants: teamShapes },
  },
};
writeSet("teams", { name: "shape-grid", definition: shapeGridWithoutSparkle }, TEAM_SEEDS, () => ({}));
