import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SHELL_FOUR_COLUMN_QUERY, SPACE_OVERLAY_QUERY } from "../src/lib/breakpoints.js";
import { SIDENAV_VIEWPORT_SHARE, SIDENAV_WIDTH_MIN } from "../src/lib/sidenav.js";
import { THREAD_LIST_VIEWPORT_SHARE, THREAD_LIST_WIDTH_MIN } from "../src/lib/threadList.js";
import { SPACE_VIEWPORT_SHARE, SPACE_WIDTH_MIN, TRANSCRIPT_MIN_WIDTH } from "../src/lib/threadSpace.js";

/* The shell's four columns used to be four fixed pixel widths with a single
   phone breakpoint under them. Between 821px and ~1400px that arithmetic does
   not close: an expanded rail (228) + thread list (318) + space panel (384)
   leaves 94px of chat on a 1024px screen — far below the 420px floor the drag
   handles enforce. Drag-time clamps could not save it, because nothing was
   being dragged; the viewport simply was that size.

   So each track now states a FLOOR and a PREFERRED width, and the grid buys
   what the viewport can pay for: side tracks reach their preferred width only
   after the chat column has its floor, and shrink toward their own floors
   before the chat column gives up another pixel. Two tiers below that drop a
   panel outright, because past a point no floor combination fits. */

const STYLES_DIR = path.join("web", "src", "styles");
const MARKER = path.join(STYLES_DIR, "tokens", "palette.css");

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`unable to locate ${MARKER}`);
    dir = parent;
  }
}

const stylesDir = path.join(findRepoRoot(), STYLES_DIR);
const readStyle = (rel: string) => readFileSync(path.join(stylesDir, rel), "utf8");

const palette = readStyle("tokens/palette.css");
const shell = readStyle("shell.css");
const responsive = readStyle("responsive.css");

function token(name: string): string {
  const found = palette.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m"));
  assert.ok(found, `palette.css must declare ${name}`);
  return found[1].trim();
}

function pxToken(name: string): number {
  const value = token(name);
  const px = value.match(/^(\d+)px$/);
  assert.ok(px, `${name} must be a plain px length, got "${value}"`);
  return Number(px[1]);
}

describe("shell column floors", () => {
  it("mirrors the drag clamps that JS already enforces", () => {
    // One number per edge, not two. The drag handles clamp to these and the
    // grid floors at these; a CSS-only copy would drift the moment either
    // side moved.
    assert.equal(pxToken("--sidenav-w-min"), SIDENAV_WIDTH_MIN);
    assert.equal(pxToken("--thread-w-min"), THREAD_LIST_WIDTH_MIN);
    assert.equal(pxToken("--space-w-min"), SPACE_WIDTH_MIN);
    assert.match(
      token("--chat-w-min"),
      new RegExp(`min\\(\\s*${TRANSCRIPT_MIN_WIDTH}px\\s*,\\s*\\d+vw\\s*\\)`),
      "the chat floor is the transcript minimum until the viewport is too small to pay it",
    );
  });
});

describe("shell grid tracks", () => {
  it("composes the grid once, from one variable per track", () => {
    // Eight near-identical `grid-template-columns` lines is how the space
    // panel's track ended up stated four times: one per state combination.
    // States now set their own track variable and the template is written
    // once.
    assert.match(
      shell,
      /\.messenger-shell\s*\{[^}]*grid-template-columns:\s*var\(--shell-nav-track\)\s+var\(--shell-rail-track\)\s+var\(--shell-chat-track\)\s+var\(--shell-space-track\);/,
      "shell.css must build grid-template-columns from the four track variables",
    );
    const templates = [...shell.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.equal(templates.length, 1, `only the base rule may state the template, found: ${templates.join(" | ")}`);
  });

  it("gives every resizable track a floor and a preferred width", () => {
    const track = (name: string, selector: RegExp): string => {
      const rule = shell.match(selector);
      assert.ok(rule, `shell.css must set ${name} in ${selector}`);
      return rule[1].trim();
    };
    assert.equal(
      track("--shell-rail-track", /\.messenger-shell\s*\{[^}]*--shell-rail-track:\s*([^;]+);/),
      "minmax(var(--thread-w-min), min(var(--thread-w), var(--thread-w-cap)))",
    );
    assert.equal(
      track("--shell-chat-track", /\.messenger-shell\s*\{[^}]*--shell-chat-track:\s*([^;]+);/),
      "minmax(var(--chat-w-min), 1fr)",
    );
    assert.equal(
      track("--shell-nav-track", /\[data-sidenav="open"\]\s*\{\s*--shell-nav-track:\s*([^;]+);/),
      "minmax(var(--sidenav-w-min), min(var(--sidenav-w-open), var(--sidenav-w-cap)))",
    );
    assert.equal(
      track("--shell-space-track", /\[data-space="open"\]\s*\{[^}]*--shell-space-track:\s*([^;]+);/),
      "minmax(var(--space-w-min), min(var(--space-w), var(--space-w-cap)))",
    );
  });

  it("keeps a collapsed track interpolable with the width it collapses from", () => {
    // The shell animates grid-template-columns. A track list only interpolates
    // when both endpoints use the same sizing function per track, so a closed
    // track is minmax(0px, 0px) rather than a bare 0 — otherwise the rail
    // snaps shut instead of sliding.
    const closed = [...`${shell}\n${responsive}`.matchAll(/--shell-(?:rail|space)-track:\s*([^;]+);/g)]
      .map((m) => m[1].trim())
      .filter((value) => /^0|minmax\(\s*0/.test(value));
    assert.ok(closed.length > 0, "some state must still close a track");
    for (const value of closed) {
      assert.equal(value, "minmax(0px, 0px)", "collapse to minmax(0px, 0px), not to a bare 0");
    }
  });
});

describe("shell column tiers", () => {
  /** The floors in play at a given viewport width, per the rules below. */
  const nav = pxToken("--sidenav-w-min");
  const rail = pxToken("--thread-w-min");
  const space = pxToken("--space-w-min");
  const chatVw = Number(token("--chat-w-min").match(/(\d+)vw/)![1]) / 100;
  const chat = (viewport: number) => Math.min(TRANSCRIPT_MIN_WIDTH, viewport * chatVw);

  it("drops a panel before the floors stop fitting", () => {
    // Every arrangement the shell can be in, at the narrowest viewport that
    // still offers it. Each must fit inside that viewport on floors alone —
    // that is the whole point of the tiers.
    const arrangements: [label: string, viewport: number, floors: number][] = [
      ["nav + rail + chat + space", 1201, nav + rail + chat(1201) + space],
      ["nav + chat + space", 1200, nav + chat(1200) + space],
      ["nav + chat + space (narrowest)", 901, nav + chat(901) + space],
      ["nav + rail + chat", 900, nav + rail + chat(900)],
      ["nav + rail + chat (narrowest)", 821, nav + rail + chat(821)],
    ];
    for (const [label, viewport, floors] of arrangements) {
      assert.ok(floors <= viewport, `${label} needs ${floors}px at ${viewport}px — drop a panel a tier earlier`);
    }
  });

  it("refuses the three-panel split below the four-column tier", () => {
    assert.equal(SHELL_FOUR_COLUMN_QUERY, "(max-width: 1200px)");
    const start = responsive.indexOf(`@media ${SHELL_FOUR_COLUMN_QUERY}`);
    assert.ok(start >= 0, "responsive.css must own the shell's four-column tier on exactly the query JS reads");
    const tier = responsive.slice(start);
    assert.match(
      tier,
      /\.messenger-shell\[data-space="open"\]\[data-threadlist="open"\]\s*\{\s*--shell-rail-track:\s*minmax\(0px, 0px\);/,
      "a re-opened thread rail beside the space panel needs a 1201px viewport",
    );
  });

  it("hands the panel's overlay tier to JS as one query", () => {
    // The panel is a <Dialog> when it overlays and a plain <aside> when it is
    // a column, and only JS can make that switch. CSS moved the takeover to
    // 900px and JS stayed on the phone query, which left an 80px band where
    // the panel covered the viewport with no scrim, no focus trap, and no
    // Escape — it looked modal and behaved like a column.
    assert.equal(SPACE_OVERLAY_QUERY, "(max-width: 900px)");
    assert.ok(
      responsive.includes(`@media ${SPACE_OVERLAY_QUERY}`),
      "responsive.css must turn the panel into an overlay on exactly the query JS reads",
    );
  });

  it("takes the space panel out of the grid below the 900px tier", () => {
    const start = responsive.indexOf("@media (max-width: 900px)");
    assert.ok(start >= 0, "responsive.css must own the shell's 900px tier");
    const tier = responsive.slice(start, responsive.indexOf("@media (max-width: 820px)"));
    assert.match(
      tier,
      /\.messenger-shell\[data-space="open"\]\s*\{[^}]*--shell-space-track:\s*minmax\(0px, 0px\);/,
      "the space track must close once the panel overlays",
    );
    assert.match(
      tier,
      /\.thread-space-panel\s*\{[^}]*position:\s*fixed/,
      "the panel overlays from 900px down, not only on phones",
    );
    // The rail is what the panel displaced; with the panel overlaying, the
    // shell is back to its default two-rail arrangement.
    assert.match(
      tier,
      /--shell-rail-track:\s*minmax\(var\(--thread-w-min\), min\(var\(--thread-w\), var\(--thread-w-cap\)\)\);/,
      "re-open the thread rail once the panel no longer occupies a track",
    );
  });
});

describe("adaptive preferred widths", () => {
  /* A `minmax(floor, preferred)` track reaches its PREFERRED width before the
     `1fr` chat track grows past its floor — that is grid's sizing order, not a
     bug we can dodge. So a preferred width stated as a bare px number is a
     promise the rails keep at the transcript's expense: at 1024px the rails
     took 228 + 318 and the conversation sat on its 420px floor, and a rail
     dragged to 480px on a wide monitor stayed 480px after the window shrank.

     Each preferred width is therefore viewport-capped — `min(px, Nvw)`. Above
     the crossover the px value wins and nothing about wide screens changes;
     below it the rails yield to the transcript first and still stop at their
     own floors. The dragged width needs no resize listener: `--thread-w` is
     the dragged px value, and min() re-reads it against every viewport. */
  const fit = (name: string, pair: string): number => {
    const value = token(name);
    const shape = value.match(/^(\d+(?:\.\d+)?)vw$/);
    assert.ok(shape, `${name} must be a bare viewport share, got "${value}"`);
    /* And the min() that applies it must be written on .messenger-shell, never
       folded into this token. A custom property is substituted where it is
       DECLARED: a `min(var(--thread-w), 26vw)` token on :root reads :root's
       318px default and inherits the computed result downward, past the width
       AppShell writes inline on .messenger-shell — every rail rendered at its
       default and dragging did nothing, with the CSS still reading correctly.
       surfaceLayout.spec.ts measures the rendered result; this only keeps the
       shape from drifting back. */
    assert.ok(
      !/min\s*\(/.test(value),
      `${name} must not compose the min() itself — shell.css owns it (see palette.css)`,
    );
    assert.ok(
      shell.includes(`min(var(${pair}), var(${name}))`),
      `shell.css must apply ${name} to ${pair} on .messenger-shell, where the inline drag width lives`,
    );
    return Number(shape[1]) / 100;
  };

  const FOUR_COLUMN_TIER = Number(SHELL_FOUR_COLUMN_QUERY.match(/(\d+)px/)![1]);
  /** Beyond this a viewport is wide enough that pinning a rail to px costs the
   *  transcript nothing, so a cap that had not yet crossed over by here would
   *  be shrinking rails on screens that have room to spare. */
  const CROSSOVER_CEILING = 1440;

  it("caps every rail's preferred width against the viewport", () => {
    const rails: [fitToken: string, pairToken: string, preferred: string][] = [
      ["--sidenav-w-cap", "--sidenav-w-open", "--sidenav-w-open"],
      ["--thread-w-cap", "--thread-w", "--thread-w"],
      ["--space-w-cap", "--space-w", "--space-w"],
    ];
    for (const [fitToken, pairToken, preferred] of rails) {
      const share = fit(fitToken, pairToken);
      const px = pxToken(preferred);
      const crossover = px / share;
      assert.ok(
        crossover > FOUR_COLUMN_TIER && crossover <= CROSSOVER_CEILING,
        `${fitToken} crosses over at ${Math.round(crossover)}px — it must reach its full ${px}px only above the ${FOUR_COLUMN_TIER}px tier and by ${CROSSOVER_CEILING}px`,
      );
    }
  });

  it("mirrors each viewport share in the drag ceiling JS enforces", () => {
    // The same pairing the floors have: CSS renders min(px, Nvw) and the drag
    // handle must stop at the same place, or the stored width climbs past a
    // rail that cannot follow it and the handle detaches from the pointer.
    assert.equal(fit("--sidenav-w-cap", "--sidenav-w-open"), SIDENAV_VIEWPORT_SHARE);
    assert.equal(fit("--thread-w-cap", "--thread-w"), THREAD_LIST_VIEWPORT_SHARE);
    assert.equal(fit("--space-w-cap", "--space-w"), SPACE_VIEWPORT_SHARE);
  });

  it("never caps a rail below the floor the grid already guarantees", () => {
    // min() may resolve under the floor on a narrow viewport; minmax's floor
    // wins there, so that is harmless. What must NOT happen is a cap that bites
    // before the floor does on the widest viewport of the rail's own tier —
    // that would be a rail narrower than its own minimum with room to spare.
    assert.ok(fit("--thread-w-cap", "--thread-w") * CROSSOVER_CEILING >= pxToken("--thread-w-min"));
    assert.ok(fit("--sidenav-w-cap", "--sidenav-w-open") * CROSSOVER_CEILING >= pxToken("--sidenav-w-min"));
    assert.ok(fit("--space-w-cap", "--space-w") * CROSSOVER_CEILING >= pxToken("--space-w-min"));
  });
});

describe("transcript measure", () => {
  const fourColumnTier = Number(SHELL_FOUR_COLUMN_QUERY.match(/(\d+)px/)![1]);

  it("grows with a wide chat column instead of leaving dead margins", () => {
    // A hard 1200px cap spent ~290px per side as margin on a 2560px monitor.
    // The floor of the clamp keeps every narrower screen exactly as it was.
    const value = token("--thread-measure");
    const shape = value.match(/^clamp\(\s*(\d+)px\s*,\s*(\d+(?:\.\d+)?)vw\s*,\s*(\d+)px\s*\)$/);
    assert.ok(shape, `--thread-measure must be clamp(px, vw, px), got "${value}"`);
    const [floor, share, ceiling] = [Number(shape[1]), Number(shape[2]) / 100, Number(shape[3])];
    assert.equal(floor, 1200, "the clamp's floor is the width the cap used to be — nothing narrower may change");
    assert.ok(ceiling > floor, "a ceiling at or below the floor is the old fixed cap with extra syntax");
    assert.ok(
      floor / share > fourColumnTier,
      "the measure must not start growing until the shell has all four columns",
    );
  });
});
