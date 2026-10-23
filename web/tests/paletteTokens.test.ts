import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STYLES_DIR = path.join("web", "src", "styles");
const MARKER = path.join(STYLES_DIR, "tokens", "palette.css");

// This file runs both from the source tree (web/tests/) and from the built
// output (dist/web/tests/), so the repo root sits at different depths. Walk up
// from wherever this module lives until the styles we read come into view.
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`unable to locate ${MARKER} above ${path.dirname(fileURLToPath(import.meta.url))}`);
    dir = parent;
  }
}

const repoRoot = findRepoRoot();
const readStyle = (rel: string) => readFileSync(path.join(repoRoot, STYLES_DIR, rel), "utf8");
const readWebSource = (rel: string) => readFileSync(path.join(repoRoot, "web", "src", rel), "utf8");

const palette = readStyle("tokens/palette.css");
const lightMarker = 'html[data-theme="light"]';
assert.ok(palette.includes(lightMarker), "palette.css is missing the light register marker");
const darkRegister = palette.slice(0, palette.indexOf(lightMarker));
const lightRegister = palette.slice(palette.indexOf(lightMarker));
// Declarations only — palette.css documents rejected values in prose on
// purpose, and a substring check would read its own explanations as code.
const paletteCode = palette.replace(/\/\*[\s\S]*?\*\//g, "");
const stripStyleComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** WCAG 2.x relative luminance / contrast, so the ramp is checked as a
 *  property rather than pinned as a list of hexes that says nothing about
 *  whether the result is readable. */
function contrast(a: string, b: string): number {
  const channel = (hex: string, i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) =>
    0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const tokenIn = (register: string, name: string): string => {
  const value = register.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`))?.[1];
  assert.ok(value, `${name} is not declared as a literal hex in its register`);
  return value;
};

/** RGB channels, so a hue can be asserted as a RELATIONSHIP (green leads,
 *  red leads, blue trails) rather than pinned to a hex that says nothing
 *  about whether the tone still reads as its meaning. */
function channels(hex: string): [number, number, number] {
  return [0, 1, 2].map((i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)) as [number, number, number];
}

describe("Relay palette tokens", () => {
  it("declares both registers: dark on :root, cream on html[data-theme=light]", () => {
    assert.match(palette, /:root\s*\{/);
    for (const name of ["--surface-0", "--ink-1", "--live", "--link-ink"]) {
      assert.match(darkRegister, new RegExp(`${name}:\\s*#[0-9a-f]{6};`), `dark register is missing ${name}`);
      assert.match(lightRegister, new RegExp(`${name}:\\s*#[0-9a-f]{6};`), `light register is missing ${name}`);
    }
  });

  it("tunes --action per register: a near-white ink plate on black, a near-black one on paper", () => {
    // eveland alignment (2026-10-23): the action is the ink, so each register
    // declares its own plate, hover and ink.
    for (const name of ["--action", "--action-hover", "--on-action"]) {
      assert.match(darkRegister, new RegExp(`${name}:\\s*#[0-9a-f]{6};`), `dark register is missing ${name}`);
      assert.match(lightRegister, new RegExp(`${name}:\\s*#[0-9a-f]{6};`), `light register is missing ${name}`);
    }
    // Contrast against black rises with luminance, so it orders the fills.
    const brightness = (hex: string) => contrast(hex, "#000000");
    const darkFill = brightness(tokenIn(darkRegister, "--action"));
    const lightFill = brightness(tokenIn(lightRegister, "--action"));
    assert.ok(darkFill > lightFill * 2, "the dark register's action must be the lighter orange");
    // Hover lifts: brighter on dark; on paper a near-black plate can only
    // lift toward grey, as eveland's button does.
    assert.ok(brightness(tokenIn(darkRegister, "--action-hover")) > darkFill);
    assert.ok(brightness(tokenIn(lightRegister, "--action-hover")) > lightFill);
    for (const register of [darkRegister, lightRegister]) {
      const [r, g, b] = channels(tokenIn(register, "--action"));
      assert.ok(r === g && g === b, "--action is ink, never a hue");
    }
    assert.match(lightRegister, /--action-soft:\s*color-mix\(in srgb, #[0-9a-f]{6} \d+%, transparent\);/);
  });

  it("carries exactly one primary button, so there is no second fill to keep in step", () => {
    // The source system runs two primary buttons: accent inside the commerce
    // flow, black on marketing surfaces. Relay is entirely in-product, so
    // accent is the action on every surface and the black pill has no
    // consumer. It used to live here as --ink-button/--on-ink-button with
    // nothing painting it — a register-varying fill that had to be kept in
    // step with a canvas it never touched. Reintroduce it only with a caller.
    for (const name of ["--ink-button", "--on-ink-button"]) {
      assert.doesNotMatch(
        darkRegister + lightRegister,
        new RegExp(`${name}:`),
        `${name} is declared with no consumer — the action is accent everywhere`,
      );
    }
  });

  it("keeps --on-action legible on the fill and its pressed state in both registers", () => {
    for (const [label, register] of [["dark", darkRegister], ["light", lightRegister]] as const) {
      const onAction = tokenIn(register, "--on-action");
      for (const fill of ["--action", "--action-hover"]) {
        const ratio = contrast(onAction, tokenIn(register, fill));
        assert.ok(ratio >= 4.5, `${label}: --on-action on ${fill} is ${ratio.toFixed(2)}:1 — below the 4.5:1 floor`);
      }
    }
  });

  it("pins both registers as tokens so nothing hand-copies a hex", () => {
    // Surfaces that must not follow the active theme (theme swatches, diff
    // chrome) read these instead of re-declaring literals.
    for (const name of [
      "--dark-canvas", "--dark-surface",
      "--dark-ink", "--dark-action",
      "--light-canvas", "--light-action",
    ]) {
      assert.match(darkRegister, new RegExp(`${name}:\\s*#[0-9a-f]{6};`), `${name} is not pinned`);
    }
  });

  it("keeps the pinned registers in step with the live ones", () => {
    // The --dark-*/--light-* tokens exist so theme-independent chrome (pre-auth
    // login, theme swatches) never hand-copies a hex. That only holds if they
    // track the register they mirror — they silently drifted apart the moment
    // the canvas moved, which is exactly the failure they were meant to stop.
    const declared = (register: string, name: string) =>
      register.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`))?.[1];
    assert.equal(declared(darkRegister, "--dark-canvas"), declared(darkRegister, "--surface-0"));
    assert.equal(declared(darkRegister, "--dark-surface"), declared(darkRegister, "--surface-1"));
    assert.equal(declared(darkRegister, "--dark-ink"), declared(darkRegister, "--ink-1"));
    assert.equal(declared(darkRegister, "--light-canvas"), declared(lightRegister, "--surface-0"));
    assert.equal(declared(darkRegister, "--dark-action"), declared(darkRegister, "--action"));
    assert.equal(declared(darkRegister, "--light-action"), declared(lightRegister, "--action"));
  });

  it("marks live work in signal blue, legible as small text in both registers", () => {
    // Two accents beyond the neutrals: the orange action and its complement,
    // a signal blue for liveness, so "working" can never be mistaken for
    // "press this". Assert the hue family (blue leads, red trails), not an
    // exact hex — and the AA floor, because an elapsed timer set in --live is
    // legible, not decorative.
    for (const [label, register] of [["dark", darkRegister], ["light", lightRegister]] as const) {
      const live = tokenIn(register, "--live");
      const [r, g, b] = channels(live);
      assert.ok(b > g && g > r, `${label} --live ${live} left the blue family (b > g > r required)`);
      const ratio = contrast(live, tokenIn(register, "--surface-0"));
      assert.ok(ratio >= 4.5, `${label} --live on --surface-0 is ${ratio.toFixed(2)}:1 — below the 4.5:1 floor`);
    }
  });

  it("offers no --live fill token", () => {
    // The palette's own rule is "dot/border/text only, never fills". A
    // --live-wash existed for exactly zero call sites and contradicted that
    // rule by handing out a translucent fill; tint a ring (pulse-ring) or an
    // ink instead. Guard the declaration so it cannot drift back in.
    assert.doesNotMatch(paletteCode, /--live-wash\s*:/, "--live is never a fill; do not reintroduce a wash token");
  });

  it("originates --live only in palette.css", () => {
    // The scope rule is enforced, not merely documented: no other token file may
    // declare the accent, and stylelint already blocks raw hex outside palette.
    for (const file of ["tokens/roles.css", "tokens/base.css", "tokens/shadcn-bridge.css"]) {
      const source = readStyle(file);
      assert.doesNotMatch(source, /--live\s*:/, `${file} must not declare --live`);
    }
  });

  it("keeps the link ink above the AA floor on every plane in both registers", () => {
    // Link ink is the action's hue, reserved for wayfinding:
    // anchors in prose and the focus ring. It must read as text wherever it
    // lands, so the bar is every plane, not just the canvas.
    for (const [label, register] of [["dark", darkRegister], ["light", lightRegister]] as const) {
      for (const plane of ["--surface-0", "--surface-1", "--surface-2", "--surface-3"]) {
        const ratio = contrast(tokenIn(register, "--link-ink"), tokenIn(register, plane));
        assert.ok(ratio >= 4.5, `${label} --link-ink on ${plane} is ${ratio.toFixed(2)}:1 — below the 4.5:1 floor`);
      }
    }
  });

  it("keeps status on the source system's semantic hues, each still reading as its meaning", () => {
    // Status here is chromatic by design — the source system publishes a green
    // success, a gold warning, and a red critical — so the guard is that
    // each tone still reads as ITS hue after the deepening that AA forced on
    // the light register. Relationships, not hexes: a green whose red channel
    // has crept past its green is no longer a green.
    for (const [label, register] of [["dark", darkRegister], ["light", lightRegister]] as const) {
      const [okR, okG, okB] = channels(tokenIn(register, "--ok"));
      assert.ok(okG > okR && okG > okB, `${label} --ok is no longer a green`);
      const [warnR, warnG, warnB] = channels(tokenIn(register, "--warn"));
      assert.ok(warnR > warnG && warnG > warnB, `${label} --warn is no longer a gold`);
      const [errR, errG, errB] = channels(tokenIn(register, "--err"));
      assert.ok(errR > errG && errR > errB, `${label} --err is no longer a red`);
      // The three must stay distinguishable from each other as hues, not just
      // as brightnesses — colour is the whole channel here.
      assert.notEqual(tokenIn(register, "--ok"), tokenIn(register, "--warn"));
      assert.notEqual(tokenIn(register, "--warn"), tokenIn(register, "--err"));
    }
    // Info is not a color — neutral notice text aliased to the ink ramp.
    const roles = readStyle("tokens/roles.css");
    assert.match(roles, /--info:\s*var\(--ink-3\);/);
  });

  it("no Fieldnotes-era values remain in palette.css", () => {
    const dead = [
      "#f7a501", "#ffb61a", "#dd9001", // the highlighter yellow action + hovers
      "#23251d", "#1f211a", "#262820", "#2d2f27", "#34362b", // olive canvas + surfaces
      "#eeefe9", "#fcfcfa", "#e5e7e0", // cream canvas + planes
      "#f1f1e8", "#d0d1c2", "#a8a999", "#9e9f8f", // olive ink ramp
      "#a0a192", "#c6c7b8", "#616257", "#55564d", // olive brightness-hierarchy status
      "#ffc233", // the yellow --live (its light-register twin #895e05 survives as --code-number)
    ];
    for (const value of dead) {
      assert.ok(!paletteCode.includes(value), `palette.css still declares ${value}`);
    }
  });
});

const login = readStyle("login.css");

describe("pre-auth login palette", () => {
  it("follows the saved theme through the live register tokens", () => {
    // The theme script in layout.tsx sets html[data-theme] before first
    // paint, so the signed-out canvas knows the theme as well as the app
    // does. The --lg-* names alias the theme register — never the pinned
    // --dark-* one — so sign-in repaints with the rest of the product.
    const loginCode = login.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(loginCode, /var\(--dark-/, "login.css must not pin the always-dark register");
    assert.match(login, /--lg-canvas:\s*var\(--surface-0\);/);
    assert.match(login, /--lg-elevated:\s*var\(--surface-2\);/);
    assert.match(login, /--lg-ink:\s*var\(--ink-1\);/);
    assert.match(login, /--lg-muted:\s*var\(--ink-3\);/);
    assert.match(login, /--lg-err:\s*var\(--err\);/);
    assert.match(login, /\.login-error \{[^}]*var\(--lg-err\)/s);
  });

  it("does not re-point the theme ink it aliases", () => {
    // --lg-ink reads --ink-1; declaring --ink-1 from --lg-ink in the same
    // scope would be a cycle that blanks every ink on the screen.
    const loginCode = login.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(loginCode, /--ink-1\s*:/);
  });

  it("speaks the product's error voice on the shared Input's invalid state", () => {
    // Public forms print errors in --err like every in-app form, and the
    // dashed danger ring on focus is base.css's contract, not restated here.
    assert.match(
      login,
      /\.login-input\[aria-invalid="true"\] \{[^}]*var\(--lg-err\)[^}]*\}/s,
      "the login field's invalid edge must use --lg-err (--err)",
    );
    assert.doesNotMatch(
      login.replace(/\/\*[\s\S]*?\*\//g, ""),
      /\.login-input\[aria-invalid="true"\] \{[^}]*outline/s,
      "the danger ring belongs to base.css",
    );
  });

  it("leads the login screen with the product's --action, unrepainted", () => {
    const loginCode = login.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(loginCode, /--action\s*:/, "login.css must not override the shared selection accent");
    assert.match(loginCode, /--lg-accent:\s*var\(--action\);/);
    assert.doesNotMatch(loginCode, /\.login-submit[^{]*\{/, "the submit is the default Button; do not repaint it");
  });

  it("originates no color of its own", () => {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(login), "login.css must not contain a raw hex color");
  });

  it("drops steel-blue, amber, and status hues", () => {
    const dead = ["#6ba1d4", "#84b3e0", "#d9a13f", "#2b1c02", "#3fb96c", "#e5635f", "#0e1216"];
    for (const value of dead) {
      assert.ok(!login.includes(value), `login.css still contains ${value}`);
    }
  });
});

const preferences = readStyle("preferences.css");

describe("theme-picker swatches", () => {
  it("mirrors the two registers through the pinned tokens", () => {
    // Swatches must show both registers at once, so the canvas can't use the
    // theme-varying --surface-0 — they read the pinned tokens, which stay in
    // sync with the registers by construction.
    assert.match(preferences, /\.pref-theme-swatch\[data-tone="light"\] \{\s*background: var\(--light-canvas\);/);
    assert.match(preferences, /\.pref-theme-swatch\[data-tone="dark"\] \{\s*background: var\(--dark-canvas\);/);
  });

  it("shows each register's own pinned accent, never the live --action", () => {
    // The accent is tuned per register, so var(--action) would paint the
    // active register's accent on both canvases. Each swatch reads its pinned
    // twin, and the system swatch splits on the canvas diagonal.
    for (const tone of ["light", "dark"]) {
      assert.match(
        preferences,
        new RegExp(`\\.pref-theme-swatch\\[data-tone="${tone}"\\]::after \\{[^}]*background: var\\(--${tone}-action\\);`, "s"),
        `${tone} swatch strip must be the pinned --${tone}-action accent`,
      );
    }
    assert.match(
      preferences,
      /\.pref-theme-swatch\[data-tone="system"\]::after \{[^}]*background: linear-gradient\(135deg, var\(--light-action\) 0 50%, var\(--dark-action\) 50% 100%\);/s,
    );
    assert.doesNotMatch(preferences, /\.pref-theme-swatch[^{]*::after \{[^}]*var\(--action\)/s);
    assert.doesNotMatch(
      preferences,
      /linear-gradient\(90deg, var\(--light-ink\) 0 50%, var\(--dark-ink\) 50% 100%\)/,
      "the split-ink strip was a Phosphor artifact — one accent serves both registers",
    );
  });

  it("originates no color of its own", () => {
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(preferences),
      "preferences.css must not contain a raw hex color",
    );
  });

  it("drops the steel-blue swatch accents", () => {
    assert.ok(!preferences.includes("#33689e"), "preferences.css still contains #33689e");
    assert.ok(!preferences.includes("#6ba1d4"), "preferences.css still contains #6ba1d4");
  });
});

describe("theme color ownership", () => {
  const appStorage = readWebSource("lib/appStorage.ts");
  const layout = readWebSource("app/layout.tsx");

  it("derives browser chrome from the active canvas token", () => {
    assert.match(appStorage, /getPropertyValue\(["']--surface-0["']\)/);
    assert.match(layout, /getPropertyValue\(["']--surface-0["']\)/);
  });

  it("does not duplicate palette hexes in theme runtime code", () => {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(appStorage), "appStorage.ts must not contain raw theme colors");
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(layout), "layout.tsx must not contain raw theme colors");
    assert.doesNotMatch(layout, /themeColor\s*:/);
  });
});

describe("opacity never dims text", () => {
  /* The ink ramp's AA guarantee — the suite directly below — is proved on the
     TOKEN. Opacity is applied at the CALL SITE, and it composites the ink
     toward whatever plane it lands on, so a rule that sets both `color` and an
     opacity below 1 silently discards the guarantee the next suite finishes
     proving. Seven rules did, and all seven failed:

       .artifact-diff-ln           --ink-3 @0.45   2.90:1 dark / 2.24:1 light
       .artifact-diff-line.is-meta --ink-3 @0.55   3.69 / 2.76
       .code-view .code-gutter     --ink-3 @0.55   3.78 / 2.67
       .relay-empty-marginalia     --ink-3 @0.6    3.60 / 2.98
       .computer-connect-usage             @0.7    4.34 / 3.75
       .msg-tokens                 --ink-4 @0.75   4.06 / 3.31
       .artifact-diff-sign         --ink-1 @0.5    5.21 / 3.50

     Three are under 3:1, the floor for content being perceivable at all, and
     every one started from an ink tier that passes.

     The ramp already answers "quieter": --ink-4 is its dim tier and exists
     because it is the dimmest value that still clears AA. Reaching past it
     with opacity is reaching past the floor by construction, which is why
     this is a structural rule rather than a per-value contrast check. */
  const stateTokens = [
    "--opacity-disabled",
    "--opacity-dormant",
    "--opacity-ghost",
    "--opacity-mark",
    "--opacity-underlay",
  ];

  const rules = (source: string) =>
    [...stripStyleComments(source).matchAll(/([^{}]*?)\{([^{}]*)\}/g)]
      .map((m) => ({ selector: m[1].trim().split("\n").pop()?.trim() ?? "", body: m[2] }))
      .filter((r) => r.selector.length > 0);

  it("declares the state scale with no two rungs sharing a value", () => {
    const values = stateTokens.map((name) => {
      const raw = paletteCode.match(new RegExp(`${name}:\\s*([0-9.]+);`))?.[1];
      assert.ok(raw, `${name} is not declared in palette.css`);
      return Number(raw);
    });
    for (const v of values) assert.ok(v > 0 && v < 1, `${v} is not a dimming value`);
    assert.equal(new Set(values).size, values.length, `two rungs share a value: ${values.join(", ")}`);
  });

  it("sets no opacity on a rule that also sets a text colour", () => {
    const offenders: string[] = [];
    for (const name of surfaceSheetNames()) {
      for (const { selector, body } of rules(readStyle(name))) {
        const opacity = body.match(/\n\s*opacity:\s*(0\.\d+)\s*;/);
        if (!opacity) continue;
        if (!/\n\s*color:\s*/.test(body)) continue;
        offenders.push(`${name}: ${selector} sets color and opacity ${opacity[1]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `step the --ink-* ramp instead of dimming text:\n  ${offenders.join("\n  ")}`,
    );
  });

  it("spells every disabled state with the one token", () => {
    // Nine rules read --opacity-disabled while three others hand-picked 0.6,
    // 0.65 and 0.72 for the identical state — under a token whose own comment
    // claimed "no call site picks its own".
    const offenders: string[] = [];
    for (const name of surfaceSheetNames()) {
      for (const { selector, body } of rules(readStyle(name))) {
        if (!/:disabled|\bis-disabled\b|\[disabled\]/.test(selector)) continue;
        const raw = body.match(/\n\s*opacity:\s*(0\.\d+)\s*;/);
        if (raw) offenders.push(`${name}: ${selector} uses ${raw[1]}`);
      }
    }
    assert.deepEqual(offenders, [], `disabled is --opacity-disabled, once:\n  ${offenders.join("\n  ")}`);
  });
});

describe("ink ramp legibility", () => {
  // The bar is the WORST plane a tier can land on, not the canvas: meta text
  // sits on drawers and inset wells too, and those are the planes closest to
  // the ink (dark: --surface-3, the lightest plane; light: --surface-2, the
  // recessed fill that moves TOWARD the ink). Sweeping every plane subsumes
  // the worst one.
  for (const [label, register, planes] of [
    ["dark", darkRegister, ["--surface-0", "--surface-1", "--surface-2", "--surface-3"]],
    ["light", lightRegister, ["--surface-0", "--surface-1", "--surface-2", "--surface-3"]],
  ] as const) {
    it(`keeps every ${label} ink tier above the AA floor on every plane`, () => {
      for (const ink of ["--ink-1", "--ink-2", "--ink-3", "--ink-4"]) {
        for (const plane of planes) {
          const ratio = contrast(tokenIn(register, ink), tokenIn(register, plane));
          assert.ok(
            ratio >= 4.5,
            `${label} ${ink} on ${plane} is ${ratio.toFixed(2)}:1 — below the 4.5:1 floor for text`
          );
        }
      }
    });

    it(`keeps the ${label} ink tiers distinguishable from each other`, () => {
      // A ramp that passes AA by collapsing into one olive is not a ramp. The
      // floor is 1.05 rather than something prouder because the light register
      // is squeezed between white and the 4.5:1 floor and genuinely has less
      // room than dark — the calm-end steps measure 1.13 dark / 1.06 light
      // (palette.css documents the squeeze). 1.05 still rejects a collapse.
      const tiers = ["--ink-1", "--ink-2", "--ink-3", "--ink-4"].map((n) => tokenIn(register, n));
      for (let i = 0; i < tiers.length - 1; i += 1) {
        const step = contrast(tiers[i], tiers[i + 1]);
        assert.ok(step >= 1.05, `${label} ink-${i + 1} → ink-${i + 2} is only ${step.toFixed(2)}:1 apart`);
      }
    });
  }

  it("keeps status tones legible as text on every plane", () => {
    // The tones render as text (counts, inline state labels), not only as dots.
    for (const [label, register] of [["dark", darkRegister], ["light", lightRegister]] as const) {
      for (const tone of ["--ok", "--warn", "--err"]) {
        for (const plane of ["--surface-0", "--surface-1", "--surface-2", "--surface-3"]) {
          const ratio = contrast(tokenIn(register, tone), tokenIn(register, plane));
          assert.ok(ratio >= 4.5, `${label} ${tone} on ${plane} is ${ratio.toFixed(2)}:1`);
        }
      }
    }
  });
});

describe("surface ladder", () => {
  it("keeps both themes' large surfaces neutral, allowing only eveland's warm paper", () => {
    // The one cast is eveland's #f7f7f5 recessed fill: a 2-step warm lean
    // (blue lowest). Anything cooler, or any visible tint, fails.
    for (const register of [darkRegister, lightRegister]) {
      for (const name of ["--surface-0", "--surface-1", "--surface-2", "--surface-3", "--surface-rail", "--surface-list", "--line-1", "--line-2"]) {
        const [r, g, b] = channels(tokenIn(register, name));
        assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2, `${name} must not tint the workspace`);
        assert.ok(b <= g && g <= r, `${name} may only lean warm, never cool`);
      }
    }
  });

  it("separates dark planes by elevation and light planes by borders", () => {
    const canvas = tokenIn(darkRegister, "--surface-0");
    const card = tokenIn(darkRegister, "--surface-1");
    const floating = tokenIn(darkRegister, "--surface-3");
    assert.ok(contrast(canvas, card) >= 1.07);
    assert.ok(contrast(canvas, floating) >= 1.1);
    assert.notEqual(card, floating);
    for (const name of ["--surface-0", "--surface-1", "--surface-3"]) {
      assert.ok(contrast(tokenIn(lightRegister, "--line-1"), tokenIn(lightRegister, name)) >= 1.4,
        `light ${name} needs a visible structural border`);
    }
    // White cards and white overlays share a fill in Geist-style light mode;
    // floating chrome must retain its border and shadow to convey depth.
    const dialog = readStyle("dialog.css");
    assert.match(readStyle("tokens/roles.css"), /--shadow-2:[^;]*var\(--line-1\)/);
    assert.match(dialog, /box-shadow:[^;]*var\(--shadow-2\)/);
  });
});

describe("focus contract", () => {
  const roles = readStyle("tokens/roles.css");

  it("draws the ring with outline in link ink, which no ancestor's overflow can clip", () => {
    // A box-shadow ring is painted inside the nearest overflow:hidden ancestor
    // and gets sliced off by it. This app is built out of scrollers and clipped
    // rows, so the ring silently lost an edge against container boundaries.
    // The ring is LINK INK, not the action fill, so a focused primary button
    // rings in a visibly different shade than its own plate.
    assert.match(roles, /--focus-outline:\s*var\(--focus-w\) solid var\(--link\);/);
    assert.match(roles, /--focus-offset:\s*\d+px;/);
    assert.doesNotMatch(roles, /--focus-ring\s*:/, "the box-shadow ring contract was replaced by outline");

    const shadowRings = [...surfaceSheetNames()].filter((name) =>
      /box-shadow:[^;]*--focus-(ring|outline)/.test(readStyle(name))
    );
    assert.deepEqual(shadowRings, [], "focus rings are outlines now — do not paint one as a box-shadow");
  });

  it("draws the ring in exactly one place", () => {
    /* base.css calls this "a single ring contract" and then 29 component
       rules copied its two declarations verbatim — `.md-table`,
       `.sidenav-resize`, `.pref-modal`, `.dialog-input`, and 25 more. Most
       sat on native buttons and inputs the contract ALREADY covered, so each
       copy overrode the shared rule with the shared rule's own value: the ring
       looked component-owned while being identical everywhere, and a change to
       --focus-outline would have been silently reverted 29 times.

       The contract now matches `[tabindex]` and `summary` as well as the
       native tags, so a hand-focusable div is covered without a copy. A
       component may still add to the focused state — a border tint, a
       box-shadow, a z-index — it just may not restate the ring itself. */
    let copies: string[] = [];
    for (const name of surfaceSheetNames()) {
      const source = stripStyleComments(readStyle(name));
      for (const m of source.matchAll(/([^{}]*?:focus-visible[^{}]*?)\{([^{}]*)\}/g)) {
        if (!/outline:\s*var\(--focus-outline\)/.test(m[2])) continue;
        copies.push(`${name}: ${m[1].replace(/\s+/g, " ").trim()}`);
      }
    }
    assert.deepEqual(
      copies,
      [],
      `the ring lives in tokens/base.css only — these restate it:\n  ${copies.join("\n  ")}`,
    );

    // And the forced-colors restatement must cover the same elements, or the
    // ring silently disappears in that mode for whatever the two lists differ on.
    const base = stripStyleComments(readStyle("tokens/base.css"));
    const contract = base.match(/([^{}]*?):focus-visible[^{}]*\{[^{}]*outline:\s*var\(--focus-outline\)/);
    const forced = base.match(/forced-colors[\s\S]*?\{\s*([\s\S]*?)\{[^{}]*CanvasText/);
    assert.ok(contract && forced, "could not locate both focus blocks in base.css");
    const selectorsOf = (block: string) =>
      block.split(",").map((p) => p.replace(/\s+/g, " ").trim())
        .filter(Boolean).map((p) => p.replace(/:focus-visible$/, "")).sort();
    assert.deepEqual(
      selectorsOf(contract[0].slice(0, contract[0].indexOf("{"))),
      selectorsOf(forced[1]),
      "the forced-colors ring covers a different set of elements than the contract",
    );
  });

  it("distinguishes the danger ring by colour AND shape", () => {
    // The critical red is its own hue now, so the danger ring can differ by
    // colour — but it keeps the dashed stroke it wore through the monochrome
    // era, because forced-colors mode drops the hue and the stroke style
    // survives it.
    for (const register of [darkRegister, lightRegister]) {
      assert.notEqual(
        tokenIn(register, "--err"),
        tokenIn(register, "--ink-1"),
        "--err carries the source system's critical hue; it is no longer the loud end of the ink ramp"
      );
    }
    const normal = roles.match(/--focus-outline:\s*([^;]+);/)?.[1] ?? "";
    const danger = roles.match(/--focus-outline-danger:\s*([^;]+);/)?.[1] ?? "";
    assert.notEqual(danger, normal, "the danger ring must not be a copy of the normal ring");
    assert.match(danger, /--err/, "the danger ring is drawn in the critical tone");
    assert.match(danger, /dashed/, "the stroke style is the channel that survives forced-colors mode");
  });
});

function surfaceSheetNames(): string[] {
  const dir = path.join(repoRoot, STYLES_DIR);
  return readdirSync(dir).filter((f) => f.endsWith(".css"));
}

describe("workspace status colors", () => {
  const workspace = readStyle("workspace.css");

  // This used to enumerate a per-tone rule per status — `.tone-good`,
  // `.tone-info`, … each naming its own hue on the pip. That shape is what the
  // tone driver exists to prevent: it is a second copy of the tone -> hue
  // mapping, and copies drift (the same enumeration in admin-v2-dashboard.css
  // resolved `neutral` to a different ink than the one here). The pip is now a
  // <StateMark>, which reads --tone through `.state-mark[data-tone]`, so the
  // hue is decided once in base.css for every status dot in the app at the
  // same time — see stateMark.test.ts and toneDriver.test.ts.
  it("reads the tone driver instead of re-deriving a hue per status", () => {
    const files = readFileSync(
      path.resolve("web", "src", "components", "workspace", "WorkspaceFilePanes.tsx"),
      "utf8",
    );
    assert.match(
      files,
      /<StateMark tone="good" \/>/,
      "the workspace status pip must be a StateMark, not a local dot",
    );
    assert.doesNotMatch(
      workspace,
      /\.workspace-status-pip/,
      "the hand-rolled pip is retired; StateMark owns the row-tier status dot",
    );
  });

  it("keeps status out of a tinted plate", () => {
    assert.doesNotMatch(
      workspace,
      /\.workspace-status-pill\b/,
      "the status pill is gone; status lives in the RecordBand",
    );
  });
});

/* A `var(--token)` with no fallback and no definition resolves to nothing, and
   CSS says nothing about it: skills.css shipped painting with `--bg`, `--text`,
   `--text-muted`, `--surface`, `--surface-hover`, `--surface-subtle`,
   `--shadow` and `--danger` — eight names the token layer never declared — so
   its muted text read at full ink, its segment track and active tab chip were
   transparent, and its error line lost the red. Every sheet is checked, since
   the failure is silent wherever it happens. */
describe("custom property definitions", () => {
  /* Injected onto <html> by the Next font loader (`variable:` in app/layout.tsx),
     so no sheet declares them. Matched by prefix — the CJK faces were added
     upstream and this guard should not need a line per font. */
  const EXTERNAL = /^--font-app-/;

  it("defines every custom property a stylesheet paints with", () => {
    const sheets = [
      ...surfaceSheetNames().map((name) => [name, readStyle(name)] as const),
      ...readdirSync(path.join(repoRoot, STYLES_DIR, "tokens"))
        .filter((name) => name.endsWith(".css"))
        .map((name) => [`tokens/${name}`, readStyle(`tokens/${name}`)] as const),
    ];
    const defined = new Set<string>();
    for (const [, css] of sheets) {
      for (const [, , name] of css.matchAll(/(^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(name!);
    }
    // Components may declare a property inline (style={{ "--x": … }}).
    for (const source of componentSources()) {
      for (const [, name] of source.matchAll(/"(--[A-Za-z0-9_-]+)"\s*:/g)) defined.add(name!);
    }
    const undefinedUses: string[] = [];
    for (const [sheet, css] of sheets) {
      // `var(--x, fallback)` is deliberate; only a bare reference must resolve.
      for (const [, name] of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
        if (!defined.has(name!) && !EXTERNAL.test(name!)) undefinedUses.push(`${sheet}: ${name}`);
      }
    }
    assert.deepEqual([...new Set(undefinedUses)].sort(), []);
  });
});

function componentSources(): string[] {
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) sources.push(readFileSync(full, "utf8"));
    }
  };
  walk(path.join(repoRoot, "web", "src"));
  return sources;
}


describe("accent primary and neutral CTA palette", () => {
  it("routes shared primary buttons through the baton-orange accent", () => {
    const bridge = readStyle("tokens/shadcn-bridge.css");
    assert.match(bridge, /--primary:\s*var\(--action\)/);
    assert.match(bridge, /--primary-foreground:\s*var\(--on-action\)/);
    assert.match(bridge, /--color-primary-hover:\s*var\(--action-hover\)/);
    const button = stripStyleComments(readWebSource("components/ui/button.tsx"));
    assert.match(button, /bg-primary text-primary-foreground hover:bg-primary-hover/);
    assert.doesNotMatch(button, /hover:text-\(--action\)/);
  });

  it("keeps the accent primary label legible at rest and on hover", () => {
    const ink = tokenIn(darkRegister, "--on-action");
    for (const fill of ["--action", "--action-hover"]) {
      assert.ok(contrast(ink, tokenIn(darkRegister, fill)) >= 4.5, `${fill} must keep its label legible`);
    }
  });

  it("keeps primary labels legible in both themes at rest and on hover", () => {
    for (const register of [darkRegister, lightRegister]) {
      const ink = tokenIn(register, "--cta-ink");
      for (const fill of ["--cta-fill", "--cta-hover"]) {
        const hex = tokenIn(register, fill);
        const [r, g, b] = channels(hex);
        assert.equal(r, g);
        assert.equal(g, b);
        assert.ok(contrast(ink, hex) >= 4.5, `${fill} must keep its label legible`);
      }
    }
    assert.ok(contrast(tokenIn(darkRegister, "--cta-fill"), tokenIn(darkRegister, "--surface-3")) >= 3);
    assert.ok(contrast(tokenIn(lightRegister, "--cta-fill"), tokenIn(lightRegister, "--surface-3")) >= 3);
  });
});
