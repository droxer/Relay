import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function cssHex(block: string, token: string): string {
  const match = block.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `missing --${token}`);
  return match[1];
}

/** Comments explain what a rule replaced, so they name the very classes these
 *  assertions forbid. Strip them before matching against real code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("UI primitive contracts", () => {
  it("keeps control boundaries at 3:1 against every theme surface", async () => {
    const palette = await readFile(resolve("web/src/styles/tokens/palette.css"), "utf8");
    const roles = await readFile(resolve("web/src/styles/tokens/roles.css"), "utf8");
    const bridge = await readFile(resolve("web/src/styles/tokens/shadcn-bridge.css"), "utf8");
    const dark = palette.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    const light = palette.match(/html\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

    assert.match(roles, /--control-border:\s*var\(--ink-4\)/);
    assert.match(bridge, /--input:\s*var\(--control-border\)/);

    for (const [name, block, surfaces] of [
      ["dark", dark, ["surface-0", "surface-1", "surface-2", "surface-3"]],
      ["light", light, ["surface-0", "surface-1", "surface-2", "surface-3"]],
    ] as const) {
      const boundary = cssHex(block, "ink-4");
      for (const surface of surfaces) {
        const ratio = contrast(boundary, cssHex(block, surface));
        assert.ok(ratio >= 3, `${name} --control-border against --${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it("applies the coarse-pointer size and type contract to wrapped and native form primitives", async () => {
    const styles = await readFile(resolve("web/src/styles/a11y.css"), "utf8");
    for (const slot of [
      "input",
      "textarea",
      "select-trigger",
      "select-item",
      "select-scroll-up-button",
      "select-scroll-down-button",
    ]) {
      assert.match(styles, new RegExp(`\\[data-slot="${slot}"\\]`));
    }
    assert.match(styles, /input:not\(\[type="hidden"\]\):not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="file"\]\)/);
    assert.match(styles, /\n\s*select,/);
    assert.match(styles, /\n\s*textarea/);
    assert.match(styles, /font-size:\s*16px/);
  });

  it("keeps a compact switch with a 44px pseudo-element hit target", async () => {
    const source = await readFile(resolve("web/src/components/ui/switch.tsx"), "utf8");
    assert.match(source, /h-5 w-9/);
    assert.match(source, /after:-inset-x-1 after:-inset-y-3/);
    assert.match(source, /data-disabled:opacity-\(--opacity-disabled\)/);
    assert.match(source, /data-checked:bg-\[var\(--action\)\]/);
    assert.doesNotMatch(source, /data-slot="switch-track"/);
  });

  it("keeps shadcn button chrome in buttonVariants instead of the later Relay layer", async () => {
    const base = await readFile(resolve("web/src/styles/tokens/base.css"), "utf8");
    assert.match(base, /:where\(button:not\(\[data-slot\]\)\)\s*\{/);
    assert.doesNotMatch(base, /button\[data-slot="button"\]\[data-variant=/);
  });

  it("consumes button variant props before spreading DOM props", async () => {
    const source = await readFile(resolve("web/src/components/ui/button.tsx"), "utf8");
    const signature = source.match(/function Button\(\{([\s\S]*?)\}: ButtonProps\)/)?.[1] ?? "";

    // Every cva modifier has to be destructured out of props, or it spreads onto
    // the DOM node and React warns about an unknown attribute.
    assert.match(signature, /\btinted\b/);
    assert.match(signature, /\bdanger\b/);
    assert.match(source, /buttonVariants\(\{ variant, size, tinted, danger, className \}\)/);
  });

  it("gives the quiet danger tier a border, not hue alone", async () => {
    const source = await readFile(resolve("web/src/components/ui/button.tsx"), "utf8");
    const danger = source.match(/danger: \{\s*true:\s*"([^"]*)"/)?.[1] ?? "";

    // Forced-colors mode discards author colours. A destructive affordance that
    // signals only with --err ink is indistinguishable from its neutral
    // siblings there, so the tier must also change SHAPE on hover and focus.
    assert.match(danger, /hover:border-\(--err\)/);
    assert.match(danger, /focus-visible:border-\(--err\)/);
    assert.match(danger, /focus-visible:\[outline:var\(--focus-outline-danger\)\]/);

    // The quiet tier stays neutral at rest — the resting ring belongs to the
    // full `destructive` variant, and repeating it down every row would turn
    // a list into a wall of red.
    assert.doesNotMatch(danger, /(^|\s)text-\(--err\)/);
    assert.doesNotMatch(danger, /(^|\s)border-\(--err\)/);
  });

  it("routes every quiet destructive action through the shared danger modifier", async () => {
    // These surfaces each used to re-implement destructive paint as a
    // descendant CSS rule, which both forked the grammar and (because
    // @layer relay is declared after Tailwind's utilities) outranked whatever
    // variant the call site asked for.
    for (const file of [
      "web/src/styles/thread.css",
      "web/src/styles/sidenav.css",
      "web/src/styles/admin-v2-channels.css",
    ]) {
      const css = await readFile(resolve(file), "utf8");
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [selector, body] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/(^|[\s,>+~])button(?![-\w])|\.danger/.test(selector)) continue;
        assert.doesNotMatch(body, /--err|--focus-outline-danger/, `${file}: ${selector.trim()}`);
      }
    }
  });

  it("wraps long select options instead of silently clipping them", async () => {
    const source = await readFile(resolve("web/src/components/ui/select.tsx"), "utf8");
    assert.match(source, /whitespace-normal/);
    assert.match(source, /overflow-wrap:anywhere/);
    assert.doesNotMatch(source, /ItemText className="[^"]*whitespace-nowrap/);
  });

  it("encodes destructive by ring and inversion rather than a translucent tint", async () => {
    const palette = await readFile(resolve("web/src/styles/tokens/palette.css"), "utf8");
    const dark = palette.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    const light = palette.match(/html\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

    // --err carries the source system's critical hue, distinct from the ink ramp, so
    // the variant reads in colour as well as in shape. It still refuses a
    // translucent fill: the source system's badge-critical is a SOLID pill, and a
    // washed-out red at rest would be indistinguishable from `ghost` on a
    // busy row.
    assert.notEqual(cssHex(dark, "err"), cssHex(dark, "ink-1"));
    assert.notEqual(cssHex(light, "err"), cssHex(light, "ink-1"));

    // The hover inversion pairs the --err fill with a DEDICATED on-tone,
    // --on-err, declared per register: the dark register's red is lifted for
    // its canvas and takes dark text, the light register's is deepened and
    // takes white, exactly as the source system's badge-critical prints it. It cannot
    // reuse --on-action, which is white in both registers.
    for (const [name, block] of [["dark", dark], ["light", light]] as const) {
      const ratio = contrast(cssHex(block, "on-err"), cssHex(block, "err"));
      assert.ok(ratio >= 4.5, `${name} --on-err on --err is ${ratio.toFixed(2)}:1 — below the 4.5:1 floor`);
    }

    const button = await readFile(resolve("web/src/components/ui/button.tsx"), "utf8");
    const destructive = button.match(/destructive:\s*\n?\s*"([^"]*)"/)?.[1] ?? "";
    assert.ok(destructive, "destructive variant missing");

    // A hairline ring at rest, a full contrast inversion on hover — never a
    // translucent fill, which would be indistinguishable from `ghost`.
    assert.match(destructive, /border-destructive/);
    assert.match(destructive, /hover:bg-destructive\b/);
    assert.match(destructive, /hover:text-destructive-foreground/);
    assert.doesNotMatch(destructive, /(?:^|\s)bg-destructive\//);
  });

  it("keeps floating chrome on the flat elevation role instead of a drop shadow", async () => {
    const roles = await readFile(resolve("web/src/styles/tokens/roles.css"), "utf8");
    assert.match(roles, /--shadow-1:\s*none/);
    // Anchored on the closing `;` so a drop shadow cannot be appended back:
    // floating chrome gets the 0.5px hairline ring and nothing else.
    assert.match(roles, /--shadow-2:\s*0 0 0 0\.5px var\(--line-1\);/);

    for (const file of ["select.tsx", "card.tsx", "toast.tsx"]) {
      const source = await readFile(resolve(`web/src/components/ui/${file}`), "utf8");
      assert.doesNotMatch(
        stripComments(source),
        /\bshadow-(?:xs|sm|md|lg|xl|2xl)\b/,
        `${file} uses a Tailwind drop shadow; planes here separate by hairline`,
      );
    }
  });

  it("orders the button size tiers so lg and icon are not smaller than default", async () => {
    const source = await readFile(resolve("web/src/components/ui/button.tsx"), "utf8");
    // `default` and `icon` both track --control-h so a square icon button lines
    // up with the buttons and inputs beside it.
    assert.match(source, /default:\s*\n?\s*"h-\(--control-h\)/);
    assert.match(source, /icon:\s*"size-\(--control-h\)"/);

    // Every tier now names a rung on the --control-h-* ladder rather than a
    // raw Tailwind step, so the ordering is checked against the ladder's real
    // values in palette.css. That is the assertion this test always wanted:
    // it used to re-derive the pixel count from the class name (`h-12` × 4)
    // and compare it to a 40 hardcoded here, which had already drifted from
    // the 44px --control-h it claimed to be reading.
    const palette = await readFile(resolve("web/src/styles/tokens/palette.css"), "utf8");
    const rung = (name: string) => {
      const px = palette.match(new RegExp(`${name}:\\s*(\\d+)px;`))?.[1];
      assert.ok(px, `${name} is not declared in palette.css`);
      return Number(px);
    };
    const ladder = ["--control-h-2xs", "--control-h-xs", "--control-h-sm", "--control-h", "--control-h-lg"];
    const heights = ladder.map(rung);
    assert.deepEqual(
      heights,
      [...heights].sort((a, b) => a - b),
      `the control ladder is out of order: ${ladder.map((n, i) => `${n}=${heights[i]}`).join(", ")}`,
    );

    const lgTier = source.match(/lg:\s*"h-\(([^)]+)\)/)?.[1];
    assert.equal(lgTier, "--control-h-lg");
    assert.ok(rung("--control-h-lg") > rung("--control-h"), "lg must sit above the pill tier");

    // No size tier may reach for a raw Tailwind height step again.
    const rawTier = source.match(/(?:^|\s)(?:"?[a-z-]+"?):\s*"(?:h|size)-\d/);
    assert.equal(rawTier, null, `button size tier uses a raw step: ${rawTier?.[0].trim()}`);
  });

  it("routes every dropdown through the Select primitive, not native <select>", async () => {
    for (const file of [
      "web/src/components/BacklogPage.tsx",
      "web/src/components/RoutinesPage.tsx",
      "web/src/components/AgentsPage.tsx",
      "web/src/components/composer/DecisionBar.tsx",
    ]) {
      const source = await readFile(resolve(file), "utf8");
      assert.doesNotMatch(
        source,
        /<select[\s>]/,
        `${file} renders a native <select>; its popup would be OS chrome, not the app's`,
      );
    }
    // Base UI resolves the trigger label from `items`; without it an unopened
    // filter renders the raw value ("all") instead of its translation.
    const filters = await readFile(resolve("web/src/components/FiltersBar.tsx"), "utf8");
    assert.match(filters, /items=\{options\}/);
  });

  it("keeps the field label/hint/error stack in the Field primitive", async () => {
    const drawers = await readFile(resolve("web/src/styles/admin-v2-drawers.css"), "utf8");
    // The old `.adm-field > span` descendant rule styled label text without a
    // component, so it only worked inside that one parent.
    assert.doesNotMatch(drawers, /\.adm-field\s*\{/);
    assert.doesNotMatch(drawers, /\.adm-field\s*>\s*span/);

    const field = await readFile(resolve("web/src/components/ui/field.tsx"), "utf8");
    assert.match(field, /data-slot="field"/);
    // A nested <label> is invalid, so label text is a <span> unless the wrapper
    // is a <div> carrying an explicit htmlFor target.
    assert.match(field, /wrapper === "div" && htmlFor/);
  });

  it("supports polite announcements for async workspace results", async () => {
    const source = await readFile(resolve("web/src/components/workspace/WorkspacePrimitives.tsx"), "utf8");
    assert.match(source, /announce\?: boolean/);
    assert.match(source, /role=\{announce \? "status" : undefined\}/);
    assert.match(source, /aria-atomic=\{announce \|\| undefined\}/);
  });
});
