import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "web", "src", "styles", "tokens", "palette.css"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("unable to locate repository root");
    dir = parent;
  }
}

const repoRoot = findRepoRoot();
const fontsDir = path.join(repoRoot, "web", "src", "app", "fonts");
const readWebSource = (rel: string) => readFileSync(path.join(repoRoot, "web", "src", rel), "utf8");

describe("local typography assets", () => {
  const VENDORED = [
    ["SpaceGrotesk-Variable-Latin.woff2", "OFL-SpaceGrotesk.txt"],
    ["SpaceMono-Regular-Latin.woff2", "OFL-SpaceMono.txt"],
  ] as const;

  it("ships each vendored face locally with its license", () => {
    const attributes = readFileSync(path.join(repoRoot, ".gitattributes"), "utf8");
    assert.doesNotMatch(attributes, /web\/src\/app\/fonts\/.*filter=lfs/);
    for (const [face, license] of VENDORED) {
      const file = path.join(fontsDir, face);
      assert.ok(existsSync(file), `missing ${face}`);
      assert.ok(statSync(file).size > 1024, `${face} is not a materialized font binary`);
      // Latin subsets stay small; a full multi-script build checked in by
      // mistake would put every visitor on a several-hundred-KB download.
      assert.ok(statSync(file).size < 120 * 1024, `${face} is larger than a Latin subset should be`);
      assert.equal(readFileSync(file).subarray(0, 4).toString("ascii"), "wOF2", `${face} is not WOFF2`);
      assert.ok(existsSync(path.join(fontsDir, license)), `missing ${license}`);
    }

    // These are the ONLY vendored files; a retired binary left in the tree
    // would ship bytes no stylesheet names.
    assert.deepEqual(readdirSync(fontsDir).sort(), VENDORED.flat().slice().sort());
  });

  it("loads only the vendored faces — no font package, Google Fonts, or CDN", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "web", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const fontPackages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter((name) => /fontsource|font-/i.test(name));
    assert.deepEqual(fontPackages, [], "the web app must not depend on a font package");

    const layout = readWebSource("app/layout.tsx");
    assert.doesNotMatch(layout, /next\/font\/google|@fontsource/, "faces are vendored, never fetched at build time");
    assert.equal([...layout.matchAll(/localFont\(/g)].length, VENDORED.length, "every vendored face loads once, and nothing else does");
    assert.doesNotMatch(layout, /fonts\.(?:googleapis|gstatic)\.com/, "the layout must not reach a font CDN");
  });

  it("leaves no retired family in the token layer", () => {
    for (const file of ["styles/tokens/palette.css", "styles/tokens/roles.css", "styles/tokens/base.css", "styles/tokens/shadcn-bridge.css"]) {
      const code = readWebSource(file).replace(/\/\*[\s\S]*?\*\//g, "");
      assert.doesNotMatch(
        code,
        /Geist|IBM Plex|Optimistic VF|Montserrat|Mona Sans|Noto Sans (?:SC |TC )?Variable|--font-app-cjk/,
        `${file} still references a retired family`,
      );
    }
  });
});

describe("application typography roles", () => {
  it("keeps the application type ladder compact without shrinking utility text below 12px", () => {
    const palette = readWebSource("styles/tokens/palette.css");
    const base = readWebSource("styles/tokens/base.css");

    const rootPercent = Number(base.match(/html\s*\{[^}]*font-size:\s*([\d.]+)%/s)?.[1]);
    assert.equal(rootPercent, 87.5, "the rem scale must continue to respect the browser font-size preference");

    const expectedPixels = new Map([
      ["--fs-1", 12],
      ["--fs-2", 14],
      ["--fs-code", 13],
      ["--fs-title", 16],
      ["--fs-5", 22],
      ["--fs-6", 28],
    ]);
    for (const [name, expected] of expectedPixels) {
      const rem = Number(palette.match(new RegExp(`${name}:\\s*([\\d.]+)rem;`))?.[1]);
      assert.ok(Number.isFinite(rem), `${name} must be declared in rem`);
      assert.ok(
        Math.abs(rem * 16 * (rootPercent / 100) - expected) < 0.01,
        `${name} should resolve to ${expected}px at the default browser size`,
      );
    }

    // Section and panel headings share one size; weight and spacing carry hierarchy.
    assert.match(palette, /--fs-heading:\s*var\(--fs-title\);/);
    assert.match(palette, /--fs-title-lg:\s*var\(--fs-title\);/);
    assert.match(palette, /--fs-document:\s*var\(--fs-title\);/);
    const roles = readWebSource("styles/tokens/roles.css");
    assert.match(roles, /--type-label:\s+500 var\(--fs-2\)\//);
    assert.match(roles, /--type-label-strong:\s+600 var\(--fs-2\)\//);

    // One reading rung: --fs-3/--fs-4 name jobs, not sizes, so they alias
    // --fs-2 instead of restating its value — and compact density, which has
    // no body rung below 14px to step onto, must not pretend to step them.
    assert.match(palette, /--fs-3:\s*var\(--fs-2\);/);
    assert.match(palette, /--fs-4:\s*var\(--fs-2\);/);
    const compact = palette.match(/\[data-density="compact"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.doesNotMatch(compact, /--fs-[34]:/, "compact density must not redefine a reading rung");

    const hero = palette.match(/--fs-hero:\s*clamp\(([\d.]+)rem,\s*4vw,\s*([\d.]+)rem\);/);
    assert.ok(hero, "--fs-hero must remain a responsive clamp");
    assert.ok(Math.abs(Number(hero[1]) * 14 - 22) < 0.01, "the hero floor should resolve to 22px");
    assert.ok(Math.abs(Number(hero[2]) * 14 - 36) < 0.01, "the hero ceiling should resolve to 36px");
  });

  it("synthesizes italic but never weight, because neither face ships an italic", () => {
    const base = readWebSource("styles/tokens/base.css");
    assert.doesNotMatch(base, /font-synthesis:\s*none/, "a blanket font-synthesis: none renders every italic upright");
    assert.match(base, /font-synthesis-weight:\s*none;/);
    assert.match(base, /font-synthesis-style:\s*auto;/);
  });

  it("pins each tier's line box to the Relay type table", () => {
    // 2026-11-22: page 22/30, panel and record titles 16/24, conversation
    // 14/23, lists, tables and forms 14/22, meta 12/18, code 13/20.
    const palette = readWebSource("styles/tokens/palette.css");
    const roles = readWebSource("styles/tokens/roles.css");
    const ratio = (name: string) => Number(palette.match(new RegExp(`${name}:\\s*([\\d.]+);`))?.[1]);
    for (const [name, size, lineBox] of [
      ["--leading-page", 22, 30],
      ["--leading-title", 16, 24],
      ["--leading-transcript", 14, 23],
      ["--leading-normal", 14, 22],
      ["--leading-caps", 12, 18],
      ["--leading-code", 13, 20],
    ] as const) {
      assert.ok(Math.abs(ratio(name) * size - lineBox) < 0.05, `${name} should give ${size}/${lineBox}`);
    }
    assert.match(palette, /--fs-transcript:\s*var\(--fs-2\);/);
    assert.match(roles, /--type-page:\s+600 var\(--fs-5\)\/var\(--leading-page\)/);
    assert.match(roles, /--type-title:\s+600 var\(--fs-title-lg\)\/var\(--leading-title\)/);
    assert.match(roles, /--type-title-content:\s+600 var\(--fs-title\)\/var\(--leading-title\)/);
    assert.match(roles, /--type-body:\s+400 var\(--fs-4\)\/var\(--leading-normal\)/);
    assert.match(roles, /--type-label:\s+500 var\(--fs-2\)\/var\(--leading-normal\)/);
    assert.match(roles, /--type-meta:\s+400 var\(--fs-1\)\/var\(--leading-caps\)/);
    assert.match(roles, /--type-code:\s+400 var\(--fs-code\)\/var\(--leading-code\)/);
  });

  it("holds every code surface on the code size, off the sans ladder", () => {
    // The mono face is sized to its own metrics. When the reading rungs moved
    // up a pixel, fenced code rode along on --fs-3 while inline code did not;
    // one token is what keeps the code surfaces the same size as each other.
    assert.match(readWebSource("styles/tokens/roles.css"), /--type-code:\s+400 var\(--fs-code\)\//);
    for (const [file, selector] of [
      ["styles/markdown.css", ".md-body code"],
      ["styles/markdown.css", ".agent-code"],
      ["styles/agent-stream.css", ".agent-thinking code"],
      ["styles/artifact.css", ".artifact-diff"],
      ["styles/artifact.css", ".artifact-plain"],
      ["styles/workspace-files.css", ".code-view-scroll"],
    ] as const) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const bodies = [...readWebSource(file).matchAll(new RegExp(`(?:^|[},\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
      const sized = bodies.filter((body) => /font-size:/.test(body));
      assert.ok(sized.length > 0, `${selector} no longer sets a size`);
      const token = selector === ".agent-thinking code" ? "--fs-code-transcript" : "--fs-code";
      for (const body of sized) assert.match(body, new RegExp(`font-size:\\s*var\\(${token}\\);`), `${selector} must size from ${token}`);
    }
  });

  it("wires Space Grotesk for the interface, Space Mono for technical text, CJK by language", () => {
    const layout = readWebSource("app/layout.tsx");
    const palette = readWebSource("styles/tokens/palette.css");

    for (const [face, variable] of [
      ["SpaceGrotesk-Variable-Latin.woff2", "--font-app-sans"],
      ["SpaceMono-Regular-Latin.woff2", "--font-app-mono"],
    ]) {
      assert.match(layout, new RegExp(`src:\\s*["']\\./fonts/${face.replace(/\./g, "\\.")}["']`));
      assert.match(layout, new RegExp(`variable:\\s*["']${variable}["']`));
    }
    assert.match(layout, /className=\{`\$\{appSans\.variable\} \$\{appMono\.variable\}`\}/);

    // Space Grotesk, then Arial / Helvetica Neue, then the language's CJK
    // faces, then the system faces; the color-emoji faces close the stack.
    assert.match(
      palette,
      /--font-sans:\s*var\(--font-app-sans\),\s*"Space Grotesk",\s*Arial,\s*"Helvetica Neue",\s*var\(--font-cjk\),\s*system-ui,/,
    );
    assert.match(palette, /--font-sans:[^;]*sans-serif,\s*"Apple Color Emoji",\s*"Segoe UI Emoji",\s*"Segoe UI Symbol",\s*"Noto Color Emoji";/);
    assert.match(palette, /--font-mono:\s*var\(--font-app-mono\),\s*"Space Mono",\s*ui-monospace,[^;]*var\(--font-cjk\),\s*monospace;/);
    assert.match(palette, /--font-display:\s*var\(--font-sans\);/);

    // Simplified faces by default, Traditional under zh-TW / zh-Hant / zh-HK.
    assert.match(palette, /:root\s*\{[\s\S]*?--font-cjk:\s*"PingFang SC",\s*"Hiragino Sans GB",\s*"Microsoft YaHei UI"/);
    assert.match(
      palette,
      /html:lang\(zh-TW\),\s*html:lang\(zh-Hant\),\s*html:lang\(zh-HK\)\s*\{\s*--font-cjk:\s*"PingFang TC",\s*"Microsoft JhengHei UI",\s*"Microsoft JhengHei",\s*"Noto Sans TC"/,
    );
  });

  it("switches on no stylistic set, because system faces assign them differently", () => {
    const code = readWebSource("styles/tokens/palette.css").replace(/\/\*[\s\S]*?\*\//g, "");

    // On San Francisco ss01/ss02 redraw the 6, 9 and 4; on Segoe UI they mean
    // something else again. The recipe stays a token so "tnum" rules can lead
    // with it, but it must not name a set.
    assert.match(code, /--font-features:\s*"kern" 1;/);
    assert.doesNotMatch(code, /"ss\d\d"/);
  });

  it("sets display at 500, titles and emphasis at 600, and keeps code at 400", () => {
    const roles = readWebSource("styles/tokens/roles.css");

    // The ladder is 400 reading, 500 labels and controls, 600 titles, headings
    // and emphasis (Relay's type table, 2026-11-22). The product deliberately
    // exposes only these three rungs even though Space Grotesk supports more.
    assert.match(roles, /--type-display:\s+500[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-title:\s+600[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-heading:\s+600[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-number:\s+500[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-label-strong:\s+600[^;]+var\(--font-sans\);/);
    // A name is not emphasis: every row carries one, so at 600 a list was a
    // wall of bold. Names lead by ink instead (see roles.css).
    assert.match(roles, /--type-name:\s+500[^;]+var\(--font-sans\);/);
    // Micro is deliberately NOT on the emphasis weight: uppercase already marks
    // it, and it is the most-applied role in the app, so putting it at the emphasis weight made
    // 42% of all typed elements bold and the emphasis tier stopped reading. It
    // takes 500, the label rung — see the weight-ladder test in
    // dimensionScales.test.ts.
    assert.match(roles, /--type-micro:\s+500[^;]+var\(--font-sans\);/);
    // Meta is supporting PROSE at the caption size, so it reads at the reading
    // weight. At 500 it was a byte-for-byte copy of micro, and a row's meta
    // line ("Claude · Runtime default") carried the same weight as the name
    // above it — the hierarchy fell to ink alone.
    assert.match(roles, /--type-meta:\s+400[^;]+var\(--font-sans\);/);
    // Supporting SENTENCES (hints, descriptions, empty-state copy) read at the
    // one reading size; only the caption roles — meta lines and group labels —
    // sit on the 12px rung. With body-sm at 12px too, ~45% of rendered text
    // was 12px and every hint read as fine print.
    assert.match(roles, /--type-body-sm:\s+400 var\(--fs-2\)\//);
    assert.match(roles, /--type-meta:\s+400 var\(--fs-1\)\//);
    assert.match(roles, /--type-micro:\s+500 var\(--fs-1\)\//);
    assert.doesNotMatch(roles, /--type-[a-z-]+:\s+[78]00/, "the product ladder deliberately stops at 600");
    assert.match(roles, /--type-code:\s+400[^;]+var\(--font-mono\);/);
    assert.match(roles, /--type-body:\s+400[^;]+var\(--font-sans\);/);
    assert.match(roles, /--type-label:\s+500[^;]+var\(--font-sans\);/);
  });

  it("sets the reading tiers solid and tightens only the display tier and the caps", () => {
    const palette = readWebSource("styles/tokens/palette.css");

    // Space Grotesk and the platform fallbacks carry their
    // own per-size tracking, so no READING
    // role adds one. The zero-valued tokens are the design, not missing
    // values; they keep the paired-track contract greppable.
    assert.match(palette, /--track-body:\s*0;/);
    assert.match(palette, /--track-body-sm:\s*0;/);
    // The display tier is the exception: reference systems tighten hard at
    // display sizes (eveland.ai runs -0.03 to -0.075em), well past what the
    // platform faces apply on their own. The 16px title tier take a
    // smaller step, so they do not crowd smaller headings.
    assert.match(palette, /--track-display:\s*-0\.03em;/);
    assert.match(palette, /--track-title:\s*-0\.02em;/);
    // Caps tracking is NOT solid any more. The source system sets its uppercase
    // captions solid because it sets them at 700, where stroke weight holds the
    // caps apart; --type-micro runs 500 here, so the track has to do that work
    // instead. Sentence-case copy at the same size uses --type-meta, which
    // tracks as body text and never picks this up.
    assert.match(palette, /--track-caps:\s*0\.03em;/);

    // --track-tight was declared 0, so its name promised a tightening it never
    // applied and its single consumer meant --track-0 all along. A token whose
    // name contradicts its value is worse than no token.
    // Strip comments first: palette.css documents the retirement in prose, and
    // a substring check would read its own explanation as the declaration.
    const code = palette.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /--track-tight:/, "--track-tight was retired; use --track-0");
    const styles = path.join(repoRoot, "web", "src", "styles");
    const stragglers = readdirSync(styles)
      .filter((f) => f.endsWith(".css"))
      .filter((f) => /var\(--track-tight\)/.test(readFileSync(path.join(styles, f), "utf8")));
    assert.deepEqual(stragglers, [], "these still reference the retired --track-tight");
  });

  it("pairs every type role with a tracking token", () => {
    // The `font:` shorthand cannot carry letter-spacing, so a role applied as
    // `font: var(--type-title)` loses its tracking unless the call site
    // remembers a second declaration — which is how an untracked login headline
    // shipped once. Pairing the tokens by name is what makes the omission
    // greppable; Linear ships --title-1 next to --title-1-letter-spacing for
    // exactly this reason.
    const roles = readWebSource("styles/tokens/roles.css");
    const declared = [...roles.matchAll(/--type-([a-z-]+):\s/g)]
      .map((m) => m[1])
      .filter((name) => !name.endsWith("-track"));
    assert.ok(declared.length >= 10, "roles.css lost its --type-* block");
    for (const role of declared) {
      assert.match(
        roles,
        new RegExp(`--type-${role}-track:\\s*var\\(--track-[a-z0-9-]+\\);`),
        `--type-${role} has no paired --type-${role}-track`
      );
    }
  });

  it("keeps the monospace column out of the inherited body tracking", () => {
    // base.css sets --track-body on html+body so every reading surface inherits
    // it. A monospace face is chosen for its fixed advance, and these are
    // strings an operator compares character by character — so every rule that
    // opts into the mono family must opt back out of the tracking.
    const styles = path.join(repoRoot, "web", "src", "styles");
    const problems: string[] = [];
    for (const file of readdirSync(styles).filter((f) => f.endsWith(".css"))) {
      const source = readFileSync(path.join(styles, file), "utf8");
      for (const rule of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const [, , body] = rule;
        // The `font:` shorthand (e.g. `font: var(--type-code)`) doesn't spell
        // `font-family:`, but it resolves to the same mono face and must opt
        // back out of the inherited body tracking just the same.
        const optsMono =
          /font-family:\s*var\(--font-mono\)/.test(body) ||
          /font:\s*var\(--type-code\)/.test(body);
        if (!optsMono) continue;
        if (/letter-spacing:/.test(body)) continue;
        problems.push(`${file}:${source.slice(0, rule.index).split("\n").length}`);
      }
    }
    assert.deepEqual(problems, [], `mono rules inheriting body tracking:\n${problems.join("\n")}`);
  });

  it("applies display tracking at every display-tier rule", () => {
    // Display text without its paired track silently loses the tracking the
    // role was designed with, and a second letter-spacing in the same rule
    // silently overrides it. The contract is PRESENCE of the declaration, not
    // a non-zero value: a track token may resolve to 0 (every track does under
    // the CJK scope), and the declaration must still be there so the pairing
    // stays greppable.
    //
    // Two shapes count as display-tier and BOTH must be swept: the --type-*
    // shorthand roles, and rules that opt into `font-family: var(--font-display)`
    // by hand (login's headline, drawer titles, stat values, …). Missing the
    // second shape is exactly how the login screen shipped untracked once.
    //
    // A role rule must name its OWN paired track token
    // (`font: var(--type-title)` → `letter-spacing: var(--type-title-track)`):
    // `var(--track-display)` resolves to the same value but severs the
    // greppable font/track pairing that roles.css legislates. Hand-rolled
    // display rules carry no role, so they read the shared value directly.
    const stylesDir = path.join(repoRoot, "web", "src", "styles");
    const files = readdirSync(stylesDir).filter((f) => f.endsWith(".css"));
    const problems: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(stylesDir, file), "utf8");
      for (const rule of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const [, selector, body] = rule;
        const role = body.match(/font:\s*var\(--type-(display|title|heading|number)\)/)?.[1];
        const isHandRolled = /font-family:\s*var\(--font-display\)/.test(body);
        if (!role && !isHandRolled) continue;
        // A single decorative glyph has no inter-character spacing to track.
        if (/relay-bleed-mark/.test(selector)) continue;
        const spacing = [...body.matchAll(/letter-spacing:\s*([^;]+);/g)].map((m) => m[1].trim());
        const accepted = role
          ? new RegExp(`^var\\(--type-${role}-track\\)$`)
          : /^var\(--(?:track-display|type-(?:display|title|heading|number)-track)\)$/;
        if (spacing.length !== 1 || !accepted.test(spacing[0])) {
          const line = source.slice(0, rule.index).split("\n").length;
          problems.push(
            `${file}:${line} → [${spacing.join(" | ") || "no letter-spacing"}]${
              role ? ` (font: var(--type-${role}) requires var(--type-${role}-track))` : ""
            }`
          );
        }
      }
    }
    assert.deepEqual(problems, [], `display-tier rules missing, overriding, or mispairing display tracking:\n${problems.join("\n")}`);
  });

  it("sets Chinese in the same system stack and only loosens its metrics", () => {
    const palette = readWebSource("styles/tokens/palette.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const base = readWebSource("styles/tokens/base.css");
    const atelier = readWebSource("styles/atelier.css");

    // Chinese and English share one family stack: Latin sets in the platform
    // UI face and Han falls through to its Simplified Chinese companion. The
    // locale block restates no reading family — it neutralises the tracking so
    // Han titles do not crush, opens the leading, and narrows the mono's Han
    // fallback to the Simplified Chinese faces.
    const localeBlock = palette.match(/html:lang\(zh-CN\),\s*html:lang\(zh-TW\)\s*\{([^}]*)\}/s)?.[1] ?? "";
    assert.notEqual(localeBlock.trim(), "", "the zh-CN metrics block went missing");
    assert.doesNotMatch(localeBlock, /--font-(?:sans|display):/, "zh-CN must not fork the reading stack");
    assert.doesNotMatch(localeBlock, /--font-(?:mono|cjk):/, "the CJK faces follow --font-cjk, not a per-block mono list");
    assert.match(localeBlock, /--track-display:\s*0;/);
    assert.match(localeBlock, /--track-title:\s*0;/);
    assert.match(localeBlock, /--track-body:\s*0;/);
    assert.match(localeBlock, /--leading-normal:\s*1\.7;/);
    // Traditional Chinese swaps --font-cjk to the TC faces; sans and mono
    // both end in it, so Han resolves to TC in both.
    const traditionalBlock = palette.match(/html:lang\(zh-HK\)\s*\{([^}]*)\}/s)?.[1] ?? "";
    assert.match(traditionalBlock, /--font-cjk:[^;]*"Noto Sans CJK TC"/);

    const eyebrowRule = base.match(/\.eyebrow\s*\{([^}]*)\}/)?.[1] ?? "";
    const headerKickerRule = atelier.match(/\.page-header-kicker,[^{]+\{([^}]*)\}/s)?.[1] ?? "";
    assert.ok(!eyebrowRule.includes("text-transform: uppercase"), "generic eyebrows should preserve sentence case");
    assert.ok(!headerKickerRule.includes("text-transform: uppercase"), "page kickers should preserve sentence case");
  });

  it("keeps CJK fallbacks available for multilingual transcripts in any UI language", () => {
    const palette = readWebSource("styles/tokens/palette.css");
    const root = palette.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

    // Agent output can be Chinese while the surrounding controls remain in
    // English, so glyph coverage cannot depend on html:lang(zh-CN).
    // --font-display ends on var(--font-sans), so expand token references
    // (to a fixed depth) before checking the stack.
    const familyOf = (role: string) => root.match(new RegExp(`--font-${role}:\\s*([^;]+);`))?.[1] ?? "";
    for (const role of ["sans", "display", "mono"]) {
      let family = familyOf(role);
      for (let depth = 0; depth < 3; depth += 1) {
        family = family.replace(/var\(--font-(sans|display|mono|cjk)\)/g, (_, alias: string) => familyOf(alias));
      }
      assert.match(family, /"PingFang SC"/, `${role} is missing the macOS CJK fallback`);
      assert.match(family, /"Microsoft YaHei/, `${role} is missing the Windows CJK fallback`);
      assert.match(family, /"Noto Sans/, `${role} is missing the Linux CJK fallback`);
    }
  });

  it("applies a saved CJK language before first paint", () => {
    const layout = readWebSource("app/layout.tsx");

    assert.match(layout, /localStorage\.getItem\(["']relay-web\.language["']\)/);
    assert.match(layout, /(?:l|language)===["']zh-CN["']/);
    assert.match(layout, /setAttribute\(["']lang["'],\s*(?:l|language)\)/);
    assert.match(layout, /(?:l|language)===["']zh-TW["']/);
  });

  it("ships English, Simplified Chinese, and Traditional Chinese", () => {
    const locales = readdirSync(path.join(repoRoot, "web", "src", "i18n", "locales")).sort();
    assert.deepEqual(locales, ["en", "zh-CN", "zh-TW"]);
  });
});
