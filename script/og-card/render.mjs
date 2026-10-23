#!/usr/bin/env node
/* Render the 1200×630 social card (web/public/og.png) that link unfurlers
   show for the public site — the paper card: eveland's white page, the
   handoff mark, the landing headline, and the handoff line drawn under it.

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
const live = token("--live");

const copy = JSON.parse(readFileSync(path.join(root, "web", "src", "i18n", "locales", "en", "translation.json"), "utf8"));
const headline = copy.landing.headline;
const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; background: ${paper}; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: ${ink};
    display: flex; flex-direction: column; padding: 80px 88px; box-sizing: border-box; position: relative; }
  .brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 600; letter-spacing: -0.02em; }
  h1 { margin: auto 0 22px; max-width: 15ch; font-size: 76px; line-height: 1.02; font-weight: 500; letter-spacing: -0.05em; }
  .meta { font-size: 24px; color: ${muted}; letter-spacing: -0.01em; }
  .line { position: absolute; right: 88px; top: 150px; width: 460px; }
</style></head><body>
  <div class="brand">
    <svg width="40" height="30" viewBox="0 0 24 18" aria-hidden="true"><g fill="none" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3 L10 9 L4 15" stroke="${lead}"/><path d="M12 3 L18 9 L12 15" stroke="${live}"/></g></svg>
    Relay
  </div>
  <svg class="line" viewBox="0 0 400 40" aria-hidden="true">
    <path d="M0 34 C120 34 150 6 230 6" fill="none" stroke="${line}" stroke-width="1.5"/>
    <path d="M230 6 C300 6 330 34 400 34" fill="none" stroke="${line}" stroke-width="1.5" stroke-dasharray="3 5"/>
  </svg>
  <h1>${escapeHtml(headline)}</h1>
  <div class="meta">Open source · Claude Code · Codex · Pi · Kimi</div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: out, type: "png" });
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
} finally {
  await browser.close();
}
