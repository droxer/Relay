#!/usr/bin/env node
/* Render the 1200×630 social card (web/public/og.png) that link unfurlers
   show for the public site — the Framed Sheet paper card, the Swiss Baton
   Cascade mark, the landing headline, and the handoff line drawn under it.

   Colours are read from web/src/styles/tokens/palette.css's light register and
   the headline from the English locale, so the card cannot drift from either.
   Regenerate after changing the headline or the light palette:

     node script/og-card/render.mjs            # writes web/public/og.png
     node script/og-card/render.mjs --out x.png
*/

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const WIDTH = 1200;
const HEIGHT = 630;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outArg = process.argv.indexOf("--out");
const out = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : path.join(root, "web", "public", "og.png");

const palette = readFileSync(path.join(root, "web", "src", "styles", "tokens", "palette.css"), "utf8");
const light = palette.slice(palette.indexOf('html[data-theme="light"]'));
function token(name) {
  const value = light.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`))?.[1];
  if (!value) throw new Error(`${name} is not a literal hex in the light register`);
  return value;
}
const ink = token("--ink-1");
const muted = token("--ink-4");
const line = token("--line-1");
const paper = token("--surface-0");
const lead = token("--brand-lead");
const switzerFont = readFileSync(path.join(root, "web", "src", "app", "fonts", "Switzer-Variable-Latin.woff2")).toString("base64");

const copy = JSON.parse(readFileSync(path.join(root, "web", "src", "i18n", "locales", "en", "translation.json"), "utf8"));
const headline = copy.landing.headline;
const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face {
    font-family: "Switzer";
    src: url("data:font/woff2;base64,${switzerFont}") format("woff2");
    font-weight: 100 900;
    font-style: normal;
  }
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; background: ${paper}; }
  body { font-family: "Switzer", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; color: ${ink};
    display: flex; flex-direction: column; padding: 80px 88px; box-sizing: border-box; position: relative; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 600; letter-spacing: -0.025em; }
  h1 { margin: auto 0 22px; max-width: 15ch; font-size: 76px; line-height: 1.02; font-weight: 600; letter-spacing: -0.035em; }
  .meta { font-size: 24px; color: ${muted}; letter-spacing: -0.01em; }
  .line { position: absolute; right: 88px; top: 150px; width: 460px; }
</style></head><body>
  <div class="brand">
    <svg width="36" height="36" viewBox="0 0 64 64" aria-hidden="true" shape-rendering="geometricPrecision">
      <path d="M14 12 H48 L43 22 H9 Z" fill="${ink}"/>
      <path d="M21 27 H55 L50 37 H16 Z" fill="${lead}"/>
      <path d="M14 42 H48 L43 52 H9 Z" fill="${ink}"/>
    </svg>
    Relay
  </div>
  <svg class="line" viewBox="0 0 400 40" aria-hidden="true">
    <path d="M0 34 C120 34 150 6 230 6" fill="none" stroke="${line}" stroke-width="1.5"/>
    <path d="M230 6 C300 6 330 34 400 34" fill="none" stroke="${line}" stroke-width="1.5" stroke-dasharray="3 5"/>
  </svg>
  <h1>${escapeHtml(headline)}</h1>
  <div class="meta">Open source · Claude Code · Codex · Pi · OpenCode · Antigravity</div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, type: "png" });
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
} finally {
  await browser.close();
}
