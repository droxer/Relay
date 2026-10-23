import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/* The page bundles only locales/en/public.json; the rest of the English
   catalogue arrives with the app chunk. A string a visitor can see before
   that chunk — on the landing page, sign-in, waitlist, password reset, or the
   auth gate — must therefore be in the public subset, or it renders as its
   key until the app loads. */

/* Run from the compiled copy under dist/ as well as from source. */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "web", "src", "i18n", "locales", "en", "translation.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("unable to locate repository root");
    dir = parent;
  }
}

const webRoot = path.join(findRepoRoot(), "web");
const read = (relative: string) => readFileSync(path.join(webRoot, relative), "utf8");

type Tree = { [key: string]: string | Tree };

/** Files whose strings a visitor sees before the app chunk arrives. */
const PUBLIC_SOURCES = [
  "src/components/landing",
  "src/components/LoginScreen.tsx",
  "src/components/waitlist",
  "src/components/password-reset",
  "src/components/AuthChecking.tsx",
  "src/components/ScreenErrorBoundary.tsx",
  "src/components/RelayEntry.tsx",
  "src/lib/landing.ts",
  "src/lib/passwordReset.ts",
];

function sourceFiles(relative: string): string[] {
  const absolute = path.join(webRoot, relative);
  if (statSync(absolute).isFile()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test."))
    .map((entry) => path.join(absolute, entry.name));
}

/** Every dotted key literal in the file, plus the key families a template
    literal (`waitlist.problem_${shape}`) names: anything under that prefix. */
function keysIn(source: string): { literals: string[]; prefixes: string[] } {
  const literals = [...source.matchAll(/["'`]([a-z_]+\.[a-z_]+(?:\.[a-z_]+)*)["'`]/g)].map((match) => match[1]);
  const prefixes = [...source.matchAll(/`([a-z_]+\.[a-z_]+(?:\.[a-z_]+)*?)\$\{/g)].map((match) => match[1]);
  return { literals, prefixes };
}

function lookup(tree: Tree, key: string): string | Tree | undefined {
  return key.split(".").reduce<string | Tree | undefined>((node, part) => (node && typeof node === "object" ? node[part] : undefined), tree);
}

function flatten(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [`${prefix}${key}`] : flatten(value, `${prefix}${key}.`));
}

describe("the eager English bundle", () => {
  const publicBundle = JSON.parse(read("src/i18n/locales/en/public.json")) as Tree;
  const catalogue = JSON.parse(read("src/i18n/locales/en/translation.json")) as Tree;

  it("holds every key the public surfaces render", () => {
    const missing: string[] = [];
    for (const file of PUBLIC_SOURCES.flatMap(sourceFiles)) {
      const { literals, prefixes } = keysIn(readFileSync(file, "utf8"));
      for (const key of literals) {
        // Only keys the catalogue knows are translation keys; other dotted
        // strings (paths, ids) are not.
        if (lookup(catalogue, key) === undefined) continue;
        if (lookup(publicBundle, key) === undefined) missing.push(`${path.relative(webRoot, file)}: ${key}`);
      }
      for (const prefix of prefixes) {
        const family = flatten(catalogue).filter((key) => key.startsWith(prefix));
        for (const key of family) {
          if (lookup(publicBundle, key) === undefined) missing.push(`${path.relative(webRoot, file)}: ${key}`);
        }
      }
    }
    assert.deepEqual(missing, [], "keys used before the app chunk loads but absent from public.json");
  });

  it("says exactly what translation.json says for those keys", () => {
    for (const key of flatten(publicBundle)) {
      assert.equal(lookup(publicBundle, key), lookup(catalogue, key), `${key} differs between public.json and translation.json`);
    }
  });

  it("stays small: whole public namespaces only, no app surface", () => {
    const namespaces = Object.keys(publicBundle).sort();
    assert.deepEqual(namespaces, ["app", "errors", "landing", "login", "password_reset", "waitlist"]);
    for (const namespace of ["landing", "login", "waitlist", "password_reset"]) {
      assert.deepEqual(publicBundle[namespace], catalogue[namespace], `${namespace} is a whole namespace`);
    }
  });
});
