// Run from any directory: node web/scripts/generate-pwa-icons.mjs.
// One vector source for browser tabs, install icons, and standalone badges.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import sharp from "sharp";

const publicDir = new URL("../public/", import.meta.url);
const output = new URL("icons/", publicDir);
const favicon = await readFile(new URL("favicon.svg", publicDir), "utf8");
const canvas = favicon.match(/<rect[^>]*fill="(#[0-9a-f]{6})"/)?.[1];
const mark = favicon.match(/<g\b[\s\S]*?<\/g>/)?.[0];
if (!canvas || !mark) throw new Error("favicon.svg must define a canvas and chevron group");
await mkdir(output, { recursive: true });

for (const size of [192, 512]) {
  await sharp(Buffer.from(favicon)).resize(size, size).png()
    .toFile(new URL(`icon-${size}.png`, output).pathname);
}

// OS launchers apply their own masks: supply a fully opaque square without
// an inset rounded tile. Android guarantees only the central 80% safe circle.
const square = (scale) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
  + `<rect width="64" height="64" fill="${canvas}"/>`
  + `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${mark}</g></svg>`);
await sharp(square(1)).resize(180, 180).removeAlpha().png()
  .toFile(new URL("apple-touch-icon.png", publicDir).pathname);
await sharp(square(0.70)).resize(512, 512).removeAlpha().png()
  .toFile(new URL("icon-maskable-512.png", output).pathname);

// PNG-backed ICO entries cover browsers and clients that request /favicon.ico.
const sizes = [16, 32, 48];
const entries = await Promise.all(sizes.map(size => sharp(Buffer.from(favicon)).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach((png, index) => {
  const entry = 6 + index * 16;
  header[entry] = header[entry + 1] = sizes[index];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
await writeFile(new URL("favicon.ico", publicDir), Buffer.concat([header, ...entries]));
await writeFile(new URL("brand/relay-mark.svg", publicDir), favicon);
await writeFile(new URL("../../assets/brand/relay-mark.svg", publicDir), favicon);
