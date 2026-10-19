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
 *
 * Every preset is drawn in the neutral grey ramp on a transparent field, so
 * the avatar chip's own theme-aware surface shows through. Identity marks
 * carry SHAPE, never hue: Relay's only accents are the ultramarine action and
 * the --live purple, and a coloured avatar beside a purple "working" dot or a
 * blue selection reads as one of them. RELAY_AVATAR_OUT overrides the output
 * directory, so the script can run from a scratch copy beside its own
 * DiceBear install.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Avatar, Style } from "@dicebear/core";
import bottts from "@dicebear/styles/bottts.json" with { type: "json" };
import lorelei from "@dicebear/styles/lorelei.json" with { type: "json" };
import personas from "@dicebear/styles/personas.json" with { type: "json" };
import pixelArt from "@dicebear/styles/pixel-art.json" with { type: "json" };
import shapeGrid from "@dicebear/styles/shape-grid.json" with { type: "json" };

const OUTPUT_ROOT =
  process.env.RELAY_AVATAR_OUT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "public", "avatars");

// Perceptual lightness band every colour is folded into. Wide enough to keep
// a face's or a robot's internal shading, narrow enough that no part vanishes
// into the chip surface in either theme (#1f1f1f dark, #ebebeb light).
const NEUTRAL_L_MIN = 0.42;
const NEUTRAL_L_MAX = 0.82;

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** One hex colour to the achromatic grey at its (folded) OKLab lightness. */
function neutralHex(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const folded = NEUTRAL_L_MIN + (NEUTRAL_L_MAX - NEUTRAL_L_MIN) * Math.min(1, Math.max(0, lightness));
  const channel = Math.round(Math.min(1, Math.max(0, linearToSrgb(folded ** 3))) * 255);
  return `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
}

const neutralize = (svg) => svg.replace(/#[0-9a-fA-F]{6}\b/g, neutralHex);
const AGENT_STYLES = [
  {
    name: "bottts",
    definition: bottts,
    seeds: [
      "bolt", "sprocket", "gizmo", "widget", "rivet", "piston", "dynamo", "gadget",
      "cog", "servo", "diode", "ratchet", "turbo", "pixel", "circuit", "beacon",
    ],
  },
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

function writeSet(kind, style, seeds) {
  const directory = join(OUTPUT_ROOT, kind);
  mkdirSync(directory, { recursive: true });
  seeds.forEach((seed, index) => {
    const id = `${style.name}-${String(index + 1).padStart(2, "0")}`;
    const svg = new Avatar(new Style(style.definition), { seed }).toString();
    writeFileSync(join(directory, `${id}.svg`), `${neutralize(svg)}\n`);
  });
}

for (const { name, definition, seeds } of AGENT_STYLES) {
  writeSet("agents", { name, definition }, seeds);
}
writeSet("teams", { name: "shape-grid", definition: shapeGrid }, TEAM_SEEDS);
