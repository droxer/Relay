// Run from any directory: node web/scripts/generate-pwa-icons.mjs.
// Derive install icons from the existing vector mark; no new brand artwork.
import { readFile, mkdir } from "node:fs/promises";
import sharp from "sharp";

const output = new URL("../public/icons/", import.meta.url);
const favicon = await readFile(new URL("../public/favicon.svg", import.meta.url));
await mkdir(output, { recursive: true });
for (const size of [192, 512]) {
  await sharp(favicon).resize(size, size).png().toFile(new URL(`icon-${size}.png`, output).pathname);
}
// An opaque full-bleed tile with the mark inside the central 80% safe circle.
const mark = await sharp(favicon).resize(320, 320).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 3, background: "#000000" } })
  .composite([{ input: mark, gravity: "centre" }]).png()
  .toFile(new URL("icon-maskable-512.png", output).pathname);
