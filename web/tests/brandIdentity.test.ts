import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The brand contract: one baton-orange hue for action, link and focus; a mark that
// draws the handoff in its register's own --action and --live; and one motion
// for every live dot. Property checks, not hex pins, wherever a relationship
// is what matters.

const MARKER = path.join("web", "src", "styles", "tokens", "palette.css");

// Runs from web/tests/ and from dist/web/tests/, so walk up to the repo root.
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
const read = (...parts: string[]) => readFileSync(path.join(repoRoot, ...parts), "utf8");
const readStyle = (rel: string) => read("web", "src", "styles", rel);

const palette = readStyle("tokens/palette.css");
const lightMarker = 'html[data-theme="light"]';
const registers = {
  dark: palette.slice(0, palette.indexOf(lightMarker)),
  light: palette.slice(palette.indexOf(lightMarker)),
} as const;

const tokenIn = (register: string, name: string): string => {
  const value = register.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`))?.[1];
  assert.ok(value, `${name} is not declared as a literal hex in its register`);
  return value;
};

/** OKLCH hue in degrees, so "same orange" is asserted perceptually. */
function oklchHue(hex: string): number {
  const lin = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(0), lin(1), lin(2)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
}

const hueGap = (x: string, y: string) => {
  const d = Math.abs(oklchHue(x) - oklchHue(y)) % 360;
  return Math.min(d, 360 - d);
};

describe("one brand orange", () => {
  it("puts --action, its hover, and the link inks on one hue", () => {
    for (const [label, register] of Object.entries(registers)) {
      const action = tokenIn(register, "--action");
      for (const name of ["--action-hover", "--link-ink", "--link-ink-strong"]) {
        const gap = hueGap(action, tokenIn(register, name));
        assert.ok(gap <= 4, `${label} ${name} sits ${gap.toFixed(1)}° off the --action hue`);
      }
    }
  });

  it("keeps the brand orange clear of the --live blue", () => {
    for (const [label, register] of Object.entries(registers)) {
      const gap = hueGap(tokenIn(register, "--action"), tokenIn(register, "--live"));
      assert.ok(gap >= 40, `${label} --action is only ${gap.toFixed(1)}° from --live; "act" would read as "working"`);
    }
  });

  it("declares no purple anywhere in the palette", () => {
    // Purple reads as generic AI-product styling, so Relay retired it:
    // liveness is signal blue, tags and syntax take other tones. Any token
    // with real chroma in the violet arc (oklch 280–340) fails here.
    for (const [label, register] of Object.entries(registers)) {
      for (const [, name, hex] of register.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6});/g)) {
        const hue = oklchHue(hex);
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const chromatic = Math.max(r, g, b) - Math.min(r, g, b) > 24;
        assert.ok(!(chromatic && hue >= 280 && hue <= 340), `${label} ${name} ${hex} is purple (hue ${hue.toFixed(0)})`);
      }
    }
  });

  it("keeps the brand orange clear of the warning gold and the critical red", () => {
    // Orange sits between two status hues. The warning moved from amber to
    // gold to make room; a gap under these floors makes a 6px status dot
    // and the action read as one colour.
    for (const [label, register] of Object.entries(registers)) {
      const action = tokenIn(register, "--action");
      const warnGap = hueGap(action, tokenIn(register, "--warn"));
      assert.ok(warnGap >= 30, `${label} --action is only ${warnGap.toFixed(1)}° from --warn`);
      const errGap = hueGap(action, tokenIn(register, "--err"));
      assert.ok(errGap >= 20, `${label} --action is only ${errGap.toFixed(1)}° from --err`);
    }
  });
});

describe("the handoff mark", () => {
  const strokes = (svg: string) => [...svg.matchAll(/<path [^>]*stroke="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  const icons = [
    { file: ["web", "public", "favicon.svg"], register: "dark" },
    { file: ["web", "public", "brand", "relay-mark.svg"], register: "light" },
  ] as const;

  for (const { file, register } of icons) {
    it(`${file.at(-1)} draws its register's canvas, --action lead and --live trail`, () => {
      const svg = read(...file);
      const tokens = registers[register];
      assert.match(svg, new RegExp(`<rect [^>]*fill="${tokenIn(tokens, "--surface-0")}"`));
      assert.deepEqual(strokes(svg), [tokenIn(tokens, "--action"), tokenIn(tokens, "--live")]);
    });
  }

  it("colours the wordmark's chevrons from both registers", () => {
    const svg = read("web", "public", "brand", "relay-logo.svg");
    for (const register of Object.values(registers)) {
      for (const name of ["--action", "--live"]) {
        assert.ok(svg.includes(tokenIn(register, name)), `relay-logo.svg is missing ${name} ${tokenIn(register, name)}`);
      }
    }
  });

  it("keeps the repository copies byte-identical and XML-valid", () => {
    for (const name of ["relay-mark.svg", "relay-logo.svg"]) {
      assert.equal(read("assets", "brand", name), read("web", "public", "brand", name), `assets/brand/${name} drifted`);
    }
    for (const file of [["web", "public", "favicon.svg"], ["web", "public", "brand", "relay-mark.svg"], ["web", "public", "brand", "relay-logo.svg"]]) {
      for (const comment of read(...file).matchAll(/<!--([\s\S]*?)-->/g)) {
        assert.ok(!comment[1].includes("--"), `${file.at(-1)}: "--" inside an XML comment breaks rasterizers`);
      }
    }
  });

  it("gives RelayMark a brand tone of --action and --live, used where Relay introduces itself", () => {
    const mark = read("web", "src", "components", "RelayMark.tsx");
    assert.match(mark, /tone\?: "ink" \| "brand"/);
    assert.match(mark, /var\(--action\)/);
    assert.match(mark, /var\(--live\)/);
    for (const surface of ["SideNav.tsx", "AuthCanvas.tsx", "landing/LandingScreen.tsx"]) {
      assert.match(read("web", "src", "components", surface), /<RelayMark [^>]*tone="brand"/, `${surface} must show the brand mark`);
    }
  });
});

describe("one live beat", () => {
  it("declares live-ring once, moving only transform and opacity", () => {
    const base = readStyle("tokens/base.css");
    const body = base.match(/@keyframes live-ring \{([\s\S]*?)\n\}/)?.[1];
    assert.ok(body, "tokens/base.css must declare @keyframes live-ring");
    const properties = new Set([...body.matchAll(/([a-z-]+):/g)].map((m) => m[1]));
    assert.deepEqual([...properties].sort(), ["opacity", "transform"]);
  });

  it("puts every live dot on live-ring, resting at a visible halo", () => {
    const hosts: Array<[string, RegExp]> = [
      ["task-status.css", /\.state-mark\[data-shape="live"\]::after \{([^}]*)\}/],
      ["inputs.css", /\.user-avatar\.running::before \{([^}]*)\}/],
      ["admin-v2-dashboard.css", /\.adm-dash-stat\.tone-live \.adm-dash-stat-dot::after \{([^}]*)\}/],
    ];
    for (const [file, selector] of hosts) {
      const rule = readStyle(file).match(selector)?.[1];
      assert.ok(rule, `${file} lost its live dot rule`);
      assert.match(rule, /animation: live-ring var\(--t-pulse\)/, `${file}: live dot must use live-ring`);
      // The static style is what reduced motion settles on: a ring, not nothing.
      assert.match(rule, /opacity: 0\.4;/, `${file}: live ring must rest visible`);
    }
  });

  // The thread-rail pip is the documented exception (its subline clips a
  // ring); stateMark.test.ts pins its in-place blink.
});

describe("one meaning per colour", () => {
  const rule = (file: string, selector: RegExp) => {
    const body = readStyle(file).match(selector)?.[1];
    assert.ok(body, `${file} lost the rule ${selector}`);
    return body;
  };

  it("draws a running composer in --live, not the action orange", () => {
    assert.match(rule("composer.css", /\.composer-input-wrap\[data-running\] \{([^}]*)\}/), /--tone: var\(--live\);/);
  });

  it("asks for a person in the waiting gold, question or gate stop alike", () => {
    const css = readStyle("awaiting-input.css");
    assert.match(rule("awaiting-input.css", /\.awaiting-input \{([^}]*)\}/), /--awaiting-rail: var\(--warn\);/);
    assert.doesNotMatch(css, /--awaiting-rail: var\(--action\)/);
  });

  it("colours review the same in the icon, the row accent, and the group band", () => {
    assert.match(readStyle("task-status.css"), /\.task-status-icon\[data-status="review"\][^{]*\{ color: var\(--ok\); \}/);
    assert.match(readStyle("backlog-list.css"), /\.backlog-row\[data-status="review"\] \{ --row-accent: var\(--ok\); \}/);
    assert.match(readStyle("issues.css"), /\.issues-band\[data-status="review"\] \{ --row-accent: var\(--ok\); \}/);
    assert.match(read("web", "src", "components", "ProjectDashboard.tsx"), /review: "good",/);
  });

  it("keeps the waiting gold off priority", () => {
    assert.doesNotMatch(readStyle("task-status.css"), /--prio-accent: var\(--warn\)/);
  });
});

describe("the brand where Relay introduces itself", () => {
  it("leads the landing page with the action plate", () => {
    const primary = readStyle("landing.css").match(/\.landing-button-primary \{([^}]*)\}/)?.[1] ?? "";
    assert.match(primary, /background: var\(--action\);/);
    assert.match(primary, /color: var\(--on-action\);/);
  });

  it("fills only the hero's door above the fold; the nav's sign-in is the outline tier", () => {
    // One filled primary per view: a second orange plate in the header beside
    // the hero's own made the page shout the same click twice.
    const screen = read("web", "src", "components", "landing", "LandingScreen.tsx");
    const nav = screen.indexOf(`<header className="landing-nav">`);
    const header = screen.slice(nav, screen.indexOf("</header>", nav));
    assert.doesNotMatch(header, /tone="primary"/);
    assert.match(header, /<CtaLink cta=\{ctas\.primary\} tone="secondary" \/>/);
  });

  it("draws both watermarks as the handoff in the two accents", () => {
    for (const [file, selector] of [["landing.css", ".landing-bleed"], ["login.css", ".login-bleed"]] as const) {
      const body = readStyle(file).match(new RegExp(`\\${selector} \\{([^}]*)\\}`))?.[1] ?? "";
      assert.match(body, /--chevron-lead: var\(--action-soft\);/, `${file} watermark lead`);
      assert.match(body, /--chevron-trail: color-mix\(in srgb, var\(--live\)/, `${file} watermark trail`);
    }
  });

  it("tells the landing page's story on the sign-in cover", () => {
    for (const locale of ["en", "zh-CN"]) {
      const copy = JSON.parse(read("web", "src", "i18n", "locales", locale, "translation.json"));
      assert.equal(copy.login.cover_headline, copy.landing.headline, `${locale}: sign-in and landing must lead with one pitch`);
    }
  });
});

describe("the chart colour rule", () => {
  // Data never wears the action colour: an orange bar beside an orange button
  // reads as clickable. Categories ride the ink ramp, --live marks only what is
  // running, --err only what failed.
  const DATA_MARK = /chart|token-seg|dash-bar|spark|meter|histogram/;
  const ACTION_INK = /var\(--(action|action-hover|link-ink|link-ink-strong)\)/;

  it("keeps --action and --link-ink off every chart mark", () => {
    const dir = path.join(repoRoot, "web", "src", "styles");
    const offenders: string[] = [];
    let checked = 0;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".css"))) {
      const css = readStyle(file).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!DATA_MARK.test(selector)) continue;
        checked += 1;
        if (ACTION_INK.test(body)) offenders.push(`${file}: ${selector.trim()}`);
      }
    }
    assert.ok(checked >= 10, `only ${checked} chart rules found; the selector pattern has gone stale`);
    assert.deepEqual(offenders, []);
  });

  it("paints chart components from the ink ramp, not the action colour", () => {
    const dir = path.join(repoRoot, "web", "src", "components", "admin", "dashboard");
    for (const file of readdirSync(dir).filter((name) => /Chart\.tsx$/.test(name))) {
      assert.ok(!ACTION_INK.test(read("web", "src", "components", "admin", "dashboard", file)), `${file} paints data with the action colour`);
    }
  });
});
