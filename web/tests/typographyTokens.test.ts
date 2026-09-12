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
  it("ships real WOFF2 binaries for both application families", () => {
    // Fieldnotes runs two families: IBM Plex Sans carries every role —
    // reading, control, and display — and JetBrains Mono covers technical
    // text only.
    for (const file of ["IBMPlexSans-Variable.woff2", "JetBrainsMono-Variable.woff2"]) {
      const absolute = path.join(fontsDir, file);
      assert.ok(existsSync(absolute), `missing ${file}`);
      assert.ok(statSync(absolute).size > 1024, `${file} is not a materialized font binary`);
      assert.equal(readFileSync(absolute).subarray(0, 4).toString("ascii"), "wOF2", `${file} is not WOFF2`);
    }
    const attributes = readFileSync(path.join(repoRoot, ".gitattributes"), "utf8");
    assert.doesNotMatch(attributes, /web\/src\/app\/fonts\/.*filter=lfs/);
    assert.ok(existsSync(path.join(fontsDir, "OFL-IBMPlexSans.txt")), "missing IBM Plex Sans license");
    assert.ok(existsSync(path.join(fontsDir, "OFL-JetBrainsMono.txt")), "missing JetBrains Mono license");
  });

  it("retires Mona Sans, Geist, and Geist Mono rather than leaving them dormant", () => {
    // Leaving the old binaries in the tree would ship ~203 KB nobody loads.
    for (const file of ["MonaSans-Variable.woff2", "Geist-Variable.woff2", "GeistMono-Variable.woff2", "OFL-MonaSans.txt"]) {
      assert.ok(!existsSync(path.join(fontsDir, file)), `${file} should have been removed`);
    }
    // No Geist reference may survive in the token layer, and the layout must
    // load the Plex binary — a renamed stack pointing at a retired file is
    // the same bug wearing a new name.
    for (const file of ["styles/tokens/palette.css", "styles/tokens/roles.css", "styles/tokens/base.css", "styles/tokens/shadcn-bridge.css"]) {
      const code = readWebSource(file).replace(/\/\*[\s\S]*?\*\//g, "");
      assert.doesNotMatch(code, /Geist/, `${file} still references the retired Geist family`);
    }
    const layout = readWebSource("app/layout.tsx");
    assert.match(layout, /src:\s*["']\.\/fonts\/IBMPlexSans-Variable\.woff2["']/);
    assert.match(layout, /variable:\s*["']--font-app-sans["']/);
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
      ["--fs-2", 13],
      ["--fs-3", 14],
      ["--fs-4", 15],
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

  it("wires one sans for every reading and display role, mono for technical text only", () => {
    const layout = readWebSource("app/layout.tsx");
    const palette = readWebSource("styles/tokens/palette.css");

    assert.match(layout, /src:\s*["']\.\/fonts\/IBMPlexSans-Variable\.woff2["']/);
    assert.match(layout, /variable:\s*["']--font-app-sans["']/);
    assert.match(layout, /src:\s*["']\.\/fonts\/JetBrainsMono-Variable\.woff2["']/);
    assert.match(layout, /variable:\s*["']--font-app-mono["']/);
    assert.doesNotMatch(layout, /MonaSans|--font-app-display|Geist/);

    // The display tier is the SANS family at a heavier weight — hierarchy
    // comes from weight and size, never from a second face. The mono is
    // technical text only.
    //
    // The source system's face is Optimistic VF, which Meta does not license for
    // redistribution: it leads the stack for anyone who has it installed, and
    // the vendored IBM Plex Sans behind it is the face this app actually
    // ships. Both must be present — a stack that names only the proprietary
    // face renders from whatever the OS guesses.
    assert.match(palette, /--font-sans:\s*["']Optimistic VF["'],\s*var\(--font-app-sans\),\s*["']IBM Plex Sans["']/);
    assert.match(palette, /--font-display:\s*var\(--font-sans\);/);
    assert.match(palette, /--font-mono:\s*var\(--font-app-mono\),\s*["']JetBrains Mono["']/);
    assert.doesNotMatch(
      palette,
      /--font-display:[^;]*(--font-app-mono|JetBrains|Mono)/,
      "the display tier is no longer mono — it resolves to the Plex sans stack",
    );
  });

  it("sets the display tiers at 500, emphasis at 700, and keeps code at 400", () => {
    const roles = readWebSource("styles/tokens/roles.css");

    // The source system's weight ramp is inverted against the usual expectation: the
    // display and heading-sm tiers are 500 and the heaviest weight in the
    // system (700) belongs to the SMALL roles — button labels, badges, body
    // emphasis. Size carries hierarchy; weight carries emphasis. An 800 would
    // render as 700 anyway (IBM Plex Sans Variable tops out there and base.css
    // disables font synthesis), so it stays out of the roles entirely.
    assert.match(roles, /--type-display:\s+500[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-title:\s+500[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-heading:\s+700[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-number:\s+500[^;]+var\(--font-display\);/);
    assert.match(roles, /--type-label-strong:\s+700[^;]+var\(--font-sans\);/);
    assert.match(roles, /--type-name:\s+700[^;]+var\(--font-sans\);/);
    assert.doesNotMatch(roles, /--type-[a-z-]+:\s+800/, "no weight 800 exists in this system — Plex tops out at 700");
    assert.match(roles, /--type-code:\s+400[^;]+var\(--font-mono\);/);
    assert.match(roles, /--type-body:\s+400[^;]+var\(--font-sans\);/);
    assert.match(roles, /--type-label:\s+500[^;]+var\(--font-sans\);/);
  });

  it("tracks the reading tiers and sets the display tier solid", () => {
    const palette = readWebSource("styles/tokens/palette.css");

    // The source system tightens its READING roles fractionally (-0.16px at 16px,
    // -0.14px at 14px ≈ -0.01em) — the snug-but-not-condensed setting
    // Optimistic VF was drawn for — and sets the display tier and the
    // uppercase captions solid, the opposite of the usual arrangement. The
    // zero-valued tokens are the design, not missing values; they keep the
    // paired-track contract greppable.
    assert.match(palette, /--track-display:\s*0;/);
    assert.match(palette, /--track-body:\s*-0\.01em;/);
    assert.match(palette, /--track-body-sm:\s*-0\.01em;/);
    assert.match(palette, /--track-caps:\s*0;/);

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

  it("keeps CJK typography internally coherent and display tracking restrained", () => {
    const palette = readWebSource("styles/tokens/palette.css");
    const base = readWebSource("styles/tokens/base.css");
    const atelier = readWebSource("styles/atelier.css");

    // IBM Plex Sans has no Han coverage, so CJK display falls back to the
    // PingFang-first sans stack (Plex remains the Latin fallback inside it) —
    // and the display tracking must be neutralised or Han titles crush.
    assert.match(
      palette,
      /html:lang\(zh-CN\)\s*\{[^}]*--font-sans:\s*"PingFang SC"[^;]+var\(--font-app-sans\)[^;]*;[^}]*--font-display:\s*var\(--font-sans\);/s,
    );
    assert.match(
      palette,
      /html:lang\(zh-TW\)\s*\{[^}]*--font-sans:\s*"PingFang TC"[^;]+var\(--font-app-sans\)[^;]*;[^}]*--font-display:\s*var\(--font-sans\);/s,
    );
    assert.match(
      palette,
      /html:lang\(zh-CN\),\s*html:lang\(zh-TW\)\s*\{[^}]*--track-display:\s*0;/s,
    );

    const eyebrowRule = base.match(/\.eyebrow\s*\{([^}]*)\}/)?.[1] ?? "";
    const headerKickerRule = atelier.match(/\.page-header-kicker,[^{]+\{([^}]*)\}/s)?.[1] ?? "";
    assert.ok(!eyebrowRule.includes("text-transform: uppercase"), "generic eyebrows should preserve sentence case");
    assert.ok(!headerKickerRule.includes("text-transform: uppercase"), "page kickers should preserve sentence case");
  });

  it("keeps CJK fallbacks available for multilingual transcripts in any UI language", () => {
    const palette = readWebSource("styles/tokens/palette.css");
    const root = palette.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

    // Agent output can be Chinese while the surrounding controls remain in
    // English, so glyph coverage cannot depend only on html:lang(zh-*).
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
});
