import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guards the contracts that stylelint cannot see. color-no-hex already stops a
// raw colour reaching a component; nothing stopped a raw *metric* — an off-grid
// gap, a duplicate breakpoint, a hand-mixed role — so those drifted instead.

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

const repoRoot = findRepoRoot();
const stylesDir = path.join(repoRoot, STYLES_DIR);
const readStyle = (rel: string) => readFileSync(path.join(stylesDir, rel), "utf8");

/** Every surface stylesheet, excluding the token layer that originates values. */
function surfaceSheets(): { name: string; source: string }[] {
  return readdirSync(stylesDir)
    .filter((f) => f.endsWith(".css"))
    .map((name) => ({ name, source: readFileSync(path.join(stylesDir, name), "utf8") }));
}

/** Drop /* … *\/ and // … so prose about a removed value isn't read as code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every .tsx under web/src, recursively. */
function componentSources(): { name: string; source: string }[] {
  const root = path.join(repoRoot, "web", "src");
  const out: { name: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) out.push({ name: path.relative(root, full), source: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return out;
}

/** Remove at-rule blocks (@media/@supports/@keyframes) — nested rules are
    sanctioned contextual overrides, not competing definitions. Bodies here
    never nest deeper than rule > declarations. Shared by the dead-declaration
    check and the sheet-ownership check below. */
function stripAtRuleBlocks(source: string): string {
  let out = source;
  const pattern = /@[a-zA-Z-]+[^{}]*\{(?:[^{}]|\{[^{}]*\})*\}/g;
  for (;;) {
    const next = out.replace(pattern, "");
    if (next === out) return out;
    out = next;
  }
}

describe("design grid", () => {
  it("phases Tailwind's numeric scale onto the --sp-* grid", () => {
    // base.css pins the root to 87.5%, so Tailwind's stock 0.25rem step became
    // 3.5px: gap-2 rendered 7px against an 8px --sp-2, and every half-step
    // landed on a fraction. Pinning --spacing to --sp-1 makes numeric N ≡ --sp-N.
    const bridge = readStyle("tokens/shadcn-bridge.css");
    assert.match(
      bridge,
      /--spacing:\s*var\(--sp-1\);/,
      "--spacing must resolve to the 4px step, or every numeric utility drifts off the --sp-* grid"
    );
  });

  it("allows only the two half-steps that have tokens", () => {
    // .5 → --sp-0-5 (2px) and 1.5 → --sp-1-5 (6px) are sanctioned. 2.5 (10px)
    // and 3.5 (14px) resolve to values with no token behind them.
    // The integer part must be neither 0 nor 1 — those are the two that have
    // tokens — so match 2..9 and anything multi-digit.
    const offGrid = /\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y|size|w|h|min-w|max-w|min-h|max-h|translate-x|translate-y|inset|top|left|right|bottom)-(?:[2-9]|\d{2,})\.5\b/g;
    const offenders = componentSources().flatMap(({ name, source }) =>
      [...source.matchAll(offGrid)].map((m) => `${name}: ${m[0]}`)
    );
    assert.deepEqual(offenders, [], "use a whole step or a 1.5/0.5 half-step — 2.5 and 3.5 have no token");
  });

  it("keeps arbitrary bracket values out of component classes", () => {
    // text-[0.8rem] (11.2px) sat between --fs-1 and --fs-2 and inverted the
    // button text ladder. Bracket escapes for *values* bypass the scale;
    // bracket selectors (data-[…], &_svg) and var references are fine.
    const arbitrary = /\b(?:text|p|px|py|pt|pb|pl|pr|m|mx|my|gap|w|h|size|rounded|leading|tracking|min-w|max-w)-\[(?!var\(|--)[^\]]+\]/g;
    const offenders = componentSources().flatMap(({ name, source }) =>
      // Comments discuss the values they replaced by name; strip them first so
      // documenting a removed `text-[0.8rem]` doesn't read as reintroducing it.
      [...stripComments(source).matchAll(arbitrary)].map((m) => `${name}: ${m[0]}`)
    );
    assert.deepEqual(offenders, [], "reference a token instead of an arbitrary value");
  });

  it("routes hover and drag edges through their roles", () => {
    // --row-hover and --line-strong were both defined WITH a comment naming the
    // call sites they consolidated, then never adopted; the hand-mixes lived on
    // and drifted to five different strengths.
    const offenders = surfaceSheets().flatMap(({ name, source }) => {
      const hits: string[] = [];
      if (/color-mix\([^)]*var\(--surface-1\)\s*60%/.test(source)) hits.push(`${name}: use var(--row-hover)`);
      if (/color-mix\([^)]*var\(--ink-1\)\s*\d+%,\s*var\(--line-1\)\)/.test(source))
        hits.push(`${name}: use var(--line-strong) or var(--line-drag)`);
      return hits;
    });
    assert.deepEqual(offenders, [], "consolidation roles exist — consume them rather than re-mixing");
  });

  it("never writes max-width: 720px, which overlaps the wide transcript rule", () => {
    // chat.css splits its grid at the complementary pair min-width:720 /
    // max-width:719. A max-width:720 rule matches at exactly 720px too, so both
    // sides of the split applied at that one width.
    const offenders = surfaceSheets()
      .filter(({ source }) => /max-width:\s*720px/.test(source))
      .map(({ name }) => name);
    assert.deepEqual(offenders, [], "the narrow side of the 720 split is max-width: 719px");
  });

  it("declares every breakpoint in the palette registry", () => {
    // Custom properties can't drive @media, so palette.css's comment block is
    // the only registry there is. 700/800/1024 each sat ~20px from a real tier.
    const palette = readStyle("tokens/palette.css");
    const registry = new Set([...palette.matchAll(/^\s*(\d{3,4})px\s{2,}/gm)].map((m) => m[1]));
    // A floor, not a pin: the point is to catch the block being deleted, not
    // to freeze how many tiers the app happens to have. It was 10 while two
    // rows (560, 768) were describing queries that no longer existed.
    assert.ok(registry.size >= 8, "palette.css lost its breakpoint registry block");

    // @container as well as @media. A container query is a breakpoint — the
    // `computer` and `record` containers both turn at 768px — and sweeping
    // only @media made that tier look orphaned when it is in active use.
    const used = new Set(
      surfaceSheets().flatMap(({ source }) =>
        [...source.matchAll(/@(?:media|container)[^{]*?\((?:max|min)-width:\s*(\d+)px\)/g)].map((m) => m[1]),
      )
    );
    // 719 is the documented complementary partner of the 720 tier.
    const undocumented = [...used].filter((px) => px !== "719" && !registry.has(px)).sort();
    assert.deepEqual(undocumented, [], "add the tier to palette.css's registry, or reuse an existing one");

    // The other direction, which used to go unchecked: a registry row whose
    // query has been deleted is worse than an unlisted tier, because a reader
    // reaching for "the nearest existing breakpoint" picks one the app does
    // not actually use. 560px ("artifact chip row") and 768px ("admin drawer
    // + admin shell collapse") had both outlived their queries.
    const orphaned = [...registry]
      .filter((px) => !used.has(px) && !used.has(String(Number(px) - 1)))
      .sort((a, b) => Number(a) - Number(b));
    assert.deepEqual(orphaned, [], "these registry rows have no query left — delete the row or restore the query");
  });

  it("keeps only z tiers that have consumers, in a usable order", () => {
    // popover(20) < drawer(30) was unusable by construction — a select inside a
    // drawer would render behind it — which is why the tier was never adopted.
    const palette = readStyle("tokens/palette.css");
    for (const dead of ["--z-popover", "--z-sheet"]) {
      assert.doesNotMatch(palette, new RegExp(`${dead}\\s*:`), `${dead} had no consumer and no workable position`);
    }
    const all = [...surfaceSheets(), ...componentSources()];
    const rawZ = all.flatMap(({ name, source }) =>
      [...source.matchAll(/z-index:\s*(\d+)/g)]
        .map((m) => ({ name, value: Number(m[1]) }))
        // 1/2/3 order siblings inside an already-positioned component.
        .filter(({ value }) => value > 3)
        .map(({ name, value }) => `${name}: z-index ${value}`)
    );
    assert.deepEqual(rawZ, [], "app-level stacking belongs to --z-drawer / --z-float / --z-dialog");
  });

  it("runs every reveal ladder off one stagger base", () => {
    // Four ladders ran at 40/80/90ms, and the workspace one existed twice —
    // an inline animationDelay in the component silently beat the stylesheet.
    const offenders = surfaceSheets().flatMap(({ name, source }) =>
      [...source.matchAll(/animation-delay:\s*(\d+m?s)/g)].map((m) => `${name}: ${m[0]}`)
    );
    assert.deepEqual(offenders, [], "express delays as calc(var(--t-stagger) * n)");

    const inlineDelay = componentSources().flatMap(({ name, source }) =>
      [...source.matchAll(/animationDelay:/g)].map(() => name)
    );
    assert.deepEqual(inlineDelay, [], "pass --stagger-index and let CSS own the cadence");
  });

  it("collapses the thread track to zero when the space panel is open", () => {
    // The split view trades the thread rail for the panel by default. Each
    // state re-points a track variable; the template itself is written once
    // (the track shapes and the tier ladder are shellColumns.test.ts).
    const shell = readStyle("shell.css");
    assert.match(
      shell,
      /\.messenger-shell\[data-space="open"\]\s*\{\s*--shell-rail-track:\s*minmax\(0px, 0px\);\s*--shell-space-track:\s*minmax\(var\(--space-w-min\), var\(--space-w\)\);/,
      "opening the space panel must close the rail track and open the space track",
    );
    assert.match(
      shell,
      /\.messenger-shell\[data-space="open"\]\[data-threadlist="open"\]\s*\{\s*--shell-rail-track:\s*minmax\(var\(--thread-w-min\), var\(--thread-w\)\);/,
      "re-opening the thread list on top of the panel must restore the rail track",
    );
  });

  it("keeps the space track out of the narrow-viewport grid", () => {
    // At <=820px there is no split view: the shell stays single-column. (The
    // panel is already a fixed overlay from the 900px tier — shellColumns.
    // test.ts owns that half.)
    const responsive = readStyle("responsive.css");
    const mobileStart = responsive.indexOf("@media (max-width: 820px)");
    assert.ok(mobileStart >= 0, "responsive.css lost its 820px block");
    const mobile = responsive.slice(mobileStart);
    const shellGrids = [...mobile.matchAll(/\.messenger-shell(?:\[[^\]]*\])*\s*\{[^}]*?grid-template-columns:\s*([^;]+);/g)]
      .map((m) => m[1].trim());
    assert.ok(shellGrids.length > 0, "the mobile block must keep pinning the shell grid");
    for (const grid of shellGrids) {
      assert.equal(grid, "minmax(0, 1fr)", "no fourth track under the narrow-viewport media query");
    }
  });

  it("leaves no declaration dead behind a later copy of its own selector", () => {
    /* Cross-sheet duplication is caught by the test below. This is the same
       failure one scope tighter: the SAME selector written twice in one sheet,
       where the earlier block's declarations are silently dead. It is stale
       edit residue and it is invisible — the rule looks right, it is just not
       the one running:

         .sidenav-more-item.active      background: --surface-2  (dead)
                                        background: --action-soft
         .task-assignment-summary-hint  color: --ink-3           (dead)
                                        color: --warn
         .backlog-task                  contain-intrinsic-size: 96px (dead)
                                        contain-intrinsic-size: 220px

       Anyone editing "the active nav background" would have found the dead
       declaration first, changed it, and seen nothing happen.

       A GROUP RULE plus a narrower override (`.a, .b { }` then `.b { }`) is
       normal authoring and is not flagged: the selectors differ, so the
       override is visible as an override. Only an exact repeat counts. */
    const collisions: string[] = [];
    for (const { name, source } of surfaceSheets()) {
      const body = stripAtRuleBlocks(stripComments(source));
      const seen = new Map<string, Map<string, string>>();
      for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const declarations = m[2]
          .split(";")
          .map((d) => d.trim())
          .filter((d) => d.includes(":"))
          .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()] as const);
        // Key on the FULL selector list, so a group rule and a narrower
        // override are different keys and only an exact repeat collides.
        const key = m[1].split(",").map((p) => p.replace(/\s+/g, " ").trim()).sort().join(", ");
        if (!key.includes(".")) continue;
        const previous = seen.get(key);
        if (!previous) {
          seen.set(key, new Map(declarations));
          continue;
        }
        for (const [prop, value] of declarations) {
          const before = previous.get(prop);
          if (before !== undefined && before !== value) {
            collisions.push(`${name}: ${key} — ${prop}: ${before} is dead, ${value} wins`);
          }
          previous.set(prop, value);
        }
      }
    }
    assert.deepEqual(
      collisions,
      [],
      `merge these into one rule:\n  ${collisions.join("\n  ")}`,
    );
  });

  it("lets no late sheet restate an earlier sheet's declaration verbatim", () => {
    /* The exempt sheets below (responsive/a11y/atelier) are allowed to
       redeclare other sheets' selectors — that is what a late override layer
       is for. What they may not do is restate a declaration with the SAME
       value, which overrides nothing and quietly moves ownership: because the
       late sheet wins, a change made in the owning sheet is reverted without
       a diff anywhere to show it. atelier.css carried 15 of these, including
       a byte-for-byte copy of shell.css's `grid-template-columns` for the
       app's main grid.

       A group rule is not flagged when any of its selectors genuinely needs
       the declaration — `.chat-header, .page-header { border-bottom }` stays,
       because .page-header has no earlier copy. Only a rule whose EVERY
       selector already carries that exact declaration counts as a copy. */
    const entry = readFileSync(path.join(repoRoot, "web", "src", "styles.css"), "utf8");
    const order = [...entry.matchAll(/@import\s+["']\.\/styles\/([^"']+\.css)["']/g)].map((m) => m[1]);
    const seen = new Map<string, string>(); // `${selector}|${prop}` -> value
    const copies: string[] = [];

    for (const name of order) {
      const file = path.join(stylesDir, name);
      if (!existsSync(file)) continue;
      const body = stripAtRuleBlocks(stripComments(readFileSync(file, "utf8")));
      const pending: [string, string][] = [];
      for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = m[1].split(",").map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
        if (!selectors.some((sel) => sel.includes("."))) continue;
        for (const declaration of m[2].split(";")) {
          if (!declaration.includes(":")) continue;
          const prop = declaration.slice(0, declaration.indexOf(":")).trim();
          const value = declaration.slice(declaration.indexOf(":") + 1).trim();
          const redundant = selectors.every((sel) => seen.get(`${sel}|${prop}`) === value);
          if (redundant) copies.push(`${name}: ${selectors.join(", ")} — ${prop}: ${value}`);
          for (const sel of selectors) pending.push([`${sel}|${prop}`, value]);
        }
      }
      // Applied after the sheet, so a rule does not shadow itself.
      for (const [key, value] of pending) seen.set(key, value);
    }
    assert.deepEqual(
      copies,
      [],
      `these restate an earlier sheet's value and override nothing — delete them:\n  ${copies.join("\n  ")}`,
    );
  });

  it("keeps each class selector owned by exactly one non-exempt sheet", () => {
    // A selector defined in two surface sheets resolves by import order, not
    // by the rule you edited — the .conversation-row / .adm-drawer-title /
    // .adm-view-toggle drift class, where atelier.css's copy silently won.
    //
    // Three sheets are exempt because they restate selectors BY DESIGN:
    //   responsive.css — the sanctioned late sheet for media-query overrides;
    //   a11y.css       — the sanctioned late sheet for reduced-motion/forced-
    //                    colors restatements;
    //   atelier.css    — a grammar layer that deliberately re-declares other
    //                    sheets' classes (documented as canonical owner at
    //                    sidenav.css:287, workspace.css:966, responsive.css:150).
    // The guard therefore only catches redefinition BETWEEN non-exempt sheets.
    const entry = readFileSync(path.join(repoRoot, "web", "src", "styles.css"), "utf8");
    const order = [...entry.matchAll(/@import\s+["']\.\/styles\/([^"']+\.css)["']/g)].map((m) => m[1]);
    assert.ok(order.length > 0, "styles.css lost its sheet imports");

    const exempt: Record<string, true> = { "responsive.css": true, "a11y.css": true, "atelier.css": true };
    const surface = new Set(surfaceSheets().map(({ name }) => name));

    const owner = new Map<string, string>();
    const duplicates: string[] = [];
    for (const name of order) {
      if (exempt[name] || !surface.has(name)) continue;
      const source = stripAtRuleBlocks(stripComments(readStyle(name)));
      // Key on the full selector (classes + attributes + pseudos), not on the
      // class names inside it: `.agents-detail .relay-empty--fill` styles the
      // empty state in context; it does not redefine `.relay-empty--fill`.
      const selectors = new Set<string>();
      for (const m of source.matchAll(/([^{}]+)\{/g)) {
        for (const part of m[1].split(",")) {
          const selector = part.replace(/\s+/g, " ").trim();
          if (selector && !selector.startsWith("@") && selector.includes(".")) selectors.add(selector);
        }
      }
      for (const selector of selectors) {
        const first = owner.get(selector);
        if (first) duplicates.push(`${selector}: defined in both ${first} and ${name}`);
        else owner.set(selector, name);
      }
    }
    assert.deepEqual(duplicates, [], "one selector, one owning sheet — overrides belong in an exempt late sheet");
  });
});
