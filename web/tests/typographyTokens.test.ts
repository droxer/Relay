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
  it("ships the technical face locally with its license", () => {
    const mono = path.join(fontsDir, "JetBrainsMono-Variable.woff2");
    assert.ok(existsSync(mono), "missing JetBrainsMono-Variable.woff2");
    assert.ok(statSync(mono).size > 1024, "JetBrainsMono-Variable.woff2 is not a materialized font binary");
    assert.equal(readFileSync(mono).subarray(0, 4).toString("ascii"), "wOF2", "JetBrainsMono-Variable.woff2 is not WOFF2");

    const attributes = readFileSync(path.join(repoRoot, ".gitattributes"), "utf8");
    assert.doesNotMatch(attributes, /web\/src\/app\/fonts\/.*filter=lfs/);
    assert.ok(existsSync(path.join(fontsDir, "OFL-JetBrainsMono.txt")), "missing JetBrains Mono license");

    // The mono is the ONLY vendored face; a retired binary left in the tree
    // would ship bytes no stylesheet names.
    assert.deepEqual(readdirSync(fontsDir).sort(), ["JetBrainsMono-Variable.woff2", "OFL-JetBrainsMono.txt"]);
  });

  it("loads no sans web font — the reading face is the platform's own", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "web", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const fontPackages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter((name) => /fontsource|font-/i.test(name));
    assert.deepEqual(fontPackages, [], "the web app must not depend on a font package");

    const layout = readWebSource("app/layout.tsx");
    assert.doesNotMatch(layout, /next\/font\/google|@fontsource/, "the layout must not load a sans web font");
    assert.equal([...layout.matchAll(/localFont\(/g)].length, 1, "the mono is the only locally loaded face");
    assert.doesNotMatch(layout, /fonts\.(?:googleapis|gstatic)\.com/, "the layout must not reach a font CDN");
  });

  it("leaves no retired family in the token layer", () => {
    for (const file of ["styles/tokens/palette.css", "styles/tokens/roles.css", "styles/tokens/base.css", "styles/tokens/shadcn-bridge.css"]) {
      const code = readWebSource(file).replace(/\/\*[\s\S]*?\*\//g, "");
      assert.doesNotMatch(
        code,
        /Geist|IBM Plex|Optimistic VF|Montserrat|Mona Sans|Noto Sans (?:SC |TC )?Variable|--font-app-(?:sans|cjk)/,
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
      ["--fs-3", 15],
      ["--fs-4", 16],
      ["--fs-code", 14],
      ["--fs-heading", 17],
      ["--fs-title", 19],
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

    const hero = palette.match(/--fs-hero:\s*clamp\(([\d.]+)rem,\s*4vw,\s*([\d.]+)rem\);/);
    assert.ok(hero, "--fs-hero must remain a responsive clamp");
    assert.ok(Math.abs(Number(hero[1]) * 14 - 22) < 0.01, "the hero floor should resolve to 22px");
    assert.ok(Math.abs(Number(hero[2]) * 14 - 36) < 0.01, "the hero ceiling should resolve to 36px");
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
      for (const body of sized) assert.match(body, /font-size:\s*var\(--fs-code\);/, `${selector} must size from --fs-code`);
    }
  });

  it("wires the system sans for every reading and display role, mono for technical text only", () => {
    const layout = readWebSource("app/layout.tsx");
    const palette = readWebSource("styles/tokens/palette.css");

    // The sans leads with the platform faces in a fixed order: Apple, then
    // Windows, then Android/ChromeOS, then the older and Linux fallbacks.
    assert.match(
      palette,
      /--font-sans:\s*-apple-system,\s*BlinkMacSystemFont,\s*"Segoe UI",\s*Roboto,\s*"Helvetica Neue",\s*"Noto Sans",\s*Arial,/,
    );
    // It ends on its generic and carries the color-emoji faces after it so a
    // pictograph never renders as a monochrome outline.
    assert.match(palette, /--font-sans:[^;]*sans-serif,\s*"Apple Color Emoji",\s*"Segoe UI Emoji",\s*"Segoe UI Symbol",\s*"Noto Color Emoji";/);

    // The technical face is the vendored JetBrains Mono, injected by the layout.
    assert.match(layout, /src:\s*["']\.\/fonts\/JetBrainsMono-Variable\.woff2["']/);
    assert.match(layout, /variable:\s*["']--font-app-mono["']/);
    assert.match(palette, /--font-mono:\s*var\(--font-app-mono\),\s*["']JetBrains Mono["']/);

    // The display tier is the SANS family at a heavier weight — hierarchy
    // comes from weight and size, never from a second face. The mono is
    // technical text only.
    assert.match(palette, /--font-display:\s*var\(--font-sans\);/);
    assert.doesNotMatch(
      palette,
      /--font-display:[^;]*(--font-app-mono|JetBrains|Mono)/,
      "the display tier is not mono — it resolves to the sans stack",
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

  it("sets the display tiers at 500, emphasis at 700, and keeps code at 400", () => {
    const roles = readWebSource("styles/tokens/roles.css");

    // The source system's weight ramp is inverted against the usual expectation: the
    // display and heading-sm tiers are 500 and the heaviest weight in the
    // system (700) belongs to the SMALL roles — button labels, badges, body
    // emphasis. Size carries hierarchy; weight carries emphasis. The product
    // deliberately exposes only the 400/500/700 ladder even though the system
    // faces support more weights.
    assert.match(roles, /--type-display:\s+500[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-title:\s+500[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-heading:\s+700[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-number:\s+500[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-label-strong:\s+700[^;]+var\(--font-sans\);/);
    assert.match(roles, /--type-name:\s+700[^;]+var\(--font-sans\);/);
    // Micro is deliberately NOT on the emphasis weight: uppercase already marks
    // it, and it is the most-applied role in the app, so putting it at 700 made
    // 42% of all typed elements bold and the emphasis tier stopped reading. It
    // takes 500 rather than 600 because the ladder stays three rungs — see the
    // weight-ladder test in dimensionScales.test.ts.
    assert.match(roles, /--type-micro:\s+500[^;]+var\(--font-sans\);/);
    assert.doesNotMatch(roles, /--type-[a-z-]+:\s+800/, "the product ladder deliberately stops at 700");
    assert.match(roles, /--type-code:\s+400[^;]+var\(--font-mono\);/);
    assert.match(roles, /--type-body:\s+400[^;]+var\(--font-sans\);/);
    assert.match(roles, /--type-label:\s+500[^;]+var\(--font-sans\);/);
  });

  it("sets the reading and display tiers solid and tracks only the caps", () => {
    const palette = readWebSource("styles/tokens/palette.css");

    // The system UI faces carry their own per-size tracking, so no reading or
    // display role adds one. The zero-valued tokens are the design, not
    // missing values; they keep the paired-track contract greppable.
    assert.match(palette, /--track-display:\s*0;/);
    assert.match(palette, /--track-body:\s*0;/);
    assert.match(palette, /--track-body-sm:\s*0;/);
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
    // a non-zero value: --type-display-track and --type-heading-track resolve
    // to var(--track-0) = 0 by design, and the declaration must still be there
    // so the pairing stays greppable.
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
    const localeBlock = palette.match(/html:lang\(zh-CN\)\s*\{([^}]*)\}/s)?.[1] ?? "";
    assert.notEqual(localeBlock.trim(), "", "the zh-CN metrics block went missing");
    assert.doesNotMatch(localeBlock, /--font-(?:sans|display):/, "zh-CN must not fork the reading stack");
    assert.match(localeBlock, /--font-mono:\s*var\(--font-app-mono\),\s*"JetBrains Mono"[^;]*"Noto Sans Mono CJK SC"/);
    assert.match(localeBlock, /--track-display:\s*0;/);
    assert.match(localeBlock, /--track-body:\s*0;/);
    assert.match(localeBlock, /--leading-normal:\s*1\.7;/);

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
    // --font-display aliases --font-sans, so resolve one level of indirection
    // before checking the stack.
    for (const role of ["sans", "display", "mono"]) {
      let family = root.match(new RegExp(`--font-${role}:\\s*([^;]+);`))?.[1] ?? "";
      const alias = family.match(/^var\(--font-([a-z-]+)\)$/)?.[1];
      if (alias) family = root.match(new RegExp(`--font-${alias}:\\s*([^;]+);`))?.[1] ?? "";
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
    // A preference saved while Traditional Chinese existed paints as
    // Simplified Chinese, matching normalizeLanguage in lib/appStorage.ts.
    assert.match(layout, /if\((?:l|language)===["']zh-TW["']\)(?:l|language)=["']zh-CN["'];/);
  });

  it("styles and ships only English and Simplified Chinese", () => {
    const stylesDir = path.join(repoRoot, "web", "src", "styles");
    const sheets = [
      ...readdirSync(stylesDir).filter((f) => f.endsWith(".css")).map((f) => path.join(stylesDir, f)),
      ...readdirSync(path.join(stylesDir, "tokens")).filter((f) => f.endsWith(".css")).map((f) => path.join(stylesDir, "tokens", f)),
    ];
    const stragglers = sheets
      .filter((file) => /:lang\(zh-(?:TW|HK|Hant)\)/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(repoRoot, file));
    assert.deepEqual(stragglers, [], "these still style a retired locale");

    const locales = readdirSync(path.join(repoRoot, "web", "src", "i18n", "locales")).sort();
    assert.deepEqual(locales, ["en", "zh-CN"]);
  });
});
