import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The old `.mono` utility was a trap: it named a monospace face but only set
   tabular figures in the sans, so every identifier wearing it (node ids,
   @handles, workspace paths, credentials) silently rendered in the reading
   face. It is now split by intent — `.tnum` for figures that must align,
   `.code` for literal strings in the code face. These tests keep the two
   apart and keep the ambiguous name from coming back. */

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "web", "src", "styles", "tokens", "base.css"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("unable to locate repository root");
    dir = parent;
  }
}

const repoRoot = findRepoRoot();
const webSrc = path.join(repoRoot, "web", "src");
const readWebSource = (rel: string) => readFileSync(path.join(webSrc, rel), "utf8");

function walk(dir: string, ext: readonly string[]): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const absolute = path.join(dir, entry);
    if (statSync(absolute).isDirectory()) return walk(absolute, ext);
    return ext.some((e) => entry.endsWith(e)) ? [absolute] : [];
  });
}

/** The `mono` class token on its own — not `--font-mono`, `font-geist-mono`,
 *  `monospace`, or the `adm-drawer-sub--mono` BEM modifier (which does set the
 *  mono family, so its name is honest). */
const BARE_MONO = /(?<![-\w])mono(?![-\w])/;

describe("type-face utilities", () => {
  it("defines .tnum in the sans and .code in the mono face", () => {
    const base = readWebSource("styles/tokens/base.css");

    const tnum = /\.tnum\s*\{([^}]*)\}/.exec(base);
    assert.ok(tnum, ".tnum is not defined in tokens/base.css");
    assert.match(tnum[1], /font-family:\s*var\(--font-sans\)/);
    assert.match(tnum[1], /font-variant-numeric:\s*tabular-nums/);

    const code = /\.code\s*\{([^}]*)\}/.exec(base);
    assert.ok(code, ".code is not defined in tokens/base.css");
    assert.match(code[1], /font-family:\s*var\(--font-mono\)/);

    // Whatever --font-mono resolves to, it must actually end in a monospace
    // fallback — that is the property `.mono` failed to deliver.
    assert.match(readWebSource("styles/tokens/palette.css"), /--font-mono:[^;]*monospace;/);
  });

  it("has retired the ambiguous .mono class everywhere", () => {
    const offenders: string[] = [];

    for (const file of walk(webSrc, [".css"])) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        // Selector position only: `.mono` as a class, not `--font-mono` etc.
        if (/(^|[\s,>+~(])\.mono(?![-\w])/.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}:${i + 1}`);
        }
      });
    }

    for (const file of walk(webSrc, [".tsx"])) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (line.includes("className") && BARE_MONO.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}:${i + 1}`);
        }
      });
    }

    assert.deepEqual(offenders, [], `\`.mono\` survives at:\n  ${offenders.join("\n  ")}`);
  });

  it("keeps identifiers on .code and figures on .tnum", () => {
    // Searched across the whole component tree rather than pinned to a named
    // file. The contract is "this class always travels with that face" — which
    // file renders it is an implementation detail, and pinning one made the
    // test fail whenever markup was merely MOVED. It broke exactly that way
    // when .adm-cred-value was extracted from CredentialsDrawer into
    // CredCopyRow so the connect-computer drawer could share it: the pairing
    // was intact, the assertion was just looking in the old place. Extraction
    // for reuse is the normal life of a component, so the assertion must not
    // treat it as a regression.
    const components = walk(path.join(webSrc, "components"), [".tsx"]).map((file) => ({
      name: path.relative(webSrc, file),
      source: readFileSync(file, "utf8"),
    }));
    const pairedWith = (utility: "code" | "tnum", cls: string) => {
      const hits = components.filter(({ source }) =>
        new RegExp(`${cls.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s+${utility}[">\`\\s]`).test(source)
      );
      assert.ok(
        hits.length > 0,
        `.${cls} is rendered somewhere without .${utility} — the two must travel together`
      );
    };

    // Identifiers: things an operator could type, paste, or diff.
    for (const cls of [
      "adm-node-card-handle",
      "adm-cred-value",
      "adm-assign-node-path",
      "workspace-path-segment",
    ]) {
      pairedWith("code", cls);
    }
    // The node id specifically must be the value wearing the code face.
    assert.match(readWebSource("components/admin/NodeRow.tsx"), /adm-node-card-handle code[^]*?\{node\.id\}/);

    // Figures: counts, stamps, ratios.
    for (const cls of [
      "conversation-stamp",
      "msg-time",
      "adm-dash-tile-value",
      // The workspace record surface's counts. These replaced a file-pinned
      // assertion on the metric strip's `<strong className="tnum">{value}</strong>`,
      // which broke the moment that strip was deleted for restating the very
      // section headers below it — the same file-pinning mistake this block's
      // header comment warns about, made one line further down.
      "workspace-page-tab-count",
      "workspace-pick-meta",
    ]) {
      pairedWith("tnum", cls);
    }
  });

  it("keeps the code recipe in the utility instead of inlining it per component", () => {
    /* `.code` is documented as the single source for the code face, and 17
       component rules reproduced its five declarations verbatim anyway —
       .agent-placement-badge, .adm-computer-chip-name, .adm-node-profile-*,
       .agent-command, and a dozen more. Nothing was visibly wrong, which is
       the point: the cost only appears when the utility changes. Adding
       var(--font-features) to the face (so tabular figures stop switching off
       the root's stylistic sets) had to be applied in 24 places instead of 2.

       Components that own their markup now wear the class. The two exceptions
       are element selectors on markup this app does not emit — react-markdown
       writes its own <code> — and they are named here so a third one cannot
       be added quietly. */
    const SANCTIONED = new Set([".md-body code", ".agent-thinking code"]);
    const RECIPE = [
      "var(--font-mono)",
      '"tnum" 1',
      "tabular-nums",
      "var(--type-code-track)",
    ];

    const offenders: string[] = [];
    for (const file of walk(path.join(webSrc, "styles"), [".css"])) {
      const name = path.relative(path.join(webSrc, "styles"), file);
      if (name.startsWith("tokens")) continue;
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of source.matchAll(/([^{}]*?)\{([^{}]*)\}/g)) {
        const selector = m[1].trim().split("\n").pop()?.trim() ?? "";
        if (!selector || SANCTIONED.has(selector)) continue;
        // A compound `.thing.code` rule is the documented re-assertion after a
        // `font` shorthand, not a copy of the utility.
        if (/\.code(?![\w-])/.test(selector)) continue;
        const hits = RECIPE.filter((decl) => m[2].includes(decl)).length;
        if (hits >= 3) offenders.push(`${name}: ${selector}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these rules inline the .code utility — put the class on the markup instead:\n  ${offenders.join("\n  ")}`,
    );
  });

  it("re-asserts the code face wherever a later `font` shorthand resets it", () => {
    // The `font` shorthand sets font-family, and these rules are imported
    // after tokens/base.css at equal specificity — so `.code` alone loses.
    const pairs: readonly (readonly [string, string])[] = [
      ["styles/admin-v2-nodes.css", "adm-node-card-name"],
      ["styles/admin-v2-users.css", "adm-node-history-identity span"],
      ["styles/admin-v2-drawers.css", "adm-assign-node-id"],
    ];

    for (const [file, selector] of pairs) {
      const source = readWebSource(file);
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(
        source,
        new RegExp(`\\.${escaped}\\.code\\s*\\{[^}]*font-family:\\s*var\\(--font-mono\\)`),
        `.${selector}.code must re-assert --font-mono in ${file}`
      );
    }
  });
});
