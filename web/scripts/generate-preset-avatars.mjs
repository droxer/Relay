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
import bottts from "@dicebear/styles/bottts.json" with { type: "json" };
import shapeGrid from "@dicebear/styles/shape-grid.json" with { type: "json" };

const OUTPUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "avatars");

// Soft backgrounds so a robot still reads as a filled chip at 16px.
const AGENT_BACKGROUNDS = ["b6e3f4", "c0aede", "d1d4f9", "ffd5dc", "ffdfbf", "c7f0d8"];
const AGENT_SEEDS = [
  "bolt", "sprocket", "gizmo", "widget", "rivet", "piston", "dynamo", "gadget",
  "cog", "servo", "diode", "ratchet", "turbo", "pixel", "circuit", "beacon",
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
    const svg = new Avatar(new Style(style.definition), { seed, ...optionsFor(index) }).toString();
    writeFileSync(join(directory, `${id}.svg`), `${svg}\n`);
  });
}

writeSet("agents", { name: "bottts", definition: bottts }, AGENT_SEEDS, (index) => ({
  backgroundColor: [AGENT_BACKGROUNDS[index % AGENT_BACKGROUNDS.length]],
}));
writeSet("teams", { name: "shape-grid", definition: shapeGrid }, TEAM_SEEDS, () => ({}));
