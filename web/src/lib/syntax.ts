import hljs from "highlight.js/lib/core";

import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Curated language set — registered once at module load. Keeping the core
// build plus an explicit list avoids pulling highlight.js's full grammar
// bundle into the static export.
const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  markdown,
  php,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

let registered = false;
function ensureRegistered() {
  if (registered) return;
  for (const [name, language] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, language);
  }
  registered = true;
}

// Aliases for grammars that cover several languages (highlight.js bundles
// JSX/TSX into javascript/typescript, HTML into xml, etc.).
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  cc: "cpp",
  "c++": "cpp",
  patch: "diff",
  udiff: "diff",
  h: "c",
  cs: "csharp",
  html: "xml",
  htm: "xml",
  svg: "xml",
  yml: "yaml",
  sh: "bash",
  zsh: "bash",
  md: "markdown",
  jsonc: "json",
};

/**
 * Resolves a language id or alias to a registered highlight.js grammar name,
 * or null when nothing matches (the caller should fall back to auto-detect).
 * Exported so fileKinds.ts's extension table can be checked against the
 * grammars actually registered here, instead of drifting silently.
 */
export function resolveLanguage(language: string | null | undefined): string | null {
  if (!language) return null;
  ensureRegistered();
  const lower = language.toLowerCase();
  const resolved = LANGUAGE_ALIASES[lower] ?? lower;
  return hljs.getLanguage(resolved) ? resolved : null;
}

/** Fence languages that mean "do not highlight this".
 *
 * An agent that labels a fence `text` is saying the block is output, not
 * source. Falling through to auto-detection there paints command output and
 * English prose as if it were code — the label has to be honoured. */
const PLAIN_LANGUAGES: ReadonlySet<string> = new Set([
  "text",
  "plaintext",
  "plain",
  "txt",
  "log",
  "output",
  "none",
]);

/** Confidence floor for auto-detection on an unlabeled fence.
 *
 * highlight.js always returns a best guess, and on a short block of prose or
 * test output that guess scores 1-2 and paints every other word a different
 * hue — noise that reads as a rendering fault. Real source in the registered
 * grammars scores 4 or more, so below that the block renders as plain text. */
const AUTO_DETECT_MIN_RELEVANCE = 4;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Whether a fence language explicitly asks for no highlighting. */
export function isPlainLanguage(language: string | null | undefined): boolean {
  return language ? PLAIN_LANGUAGES.has(language.toLowerCase()) : false;
}

/** Auto-detect, but only paint the block when the guess is confident enough. */
function autoHighlight(code: string): string {
  const detected = hljs.highlightAuto(code);
  if (detected.relevance < AUTO_DETECT_MIN_RELEVANCE) return escapeHtml(code);
  return detected.value;
}

// Bounded LRU over highlight results. Transcript re-renders (every streamed
// delta re-renders every visible message) would otherwise re-run highlighting
// — including the expensive highlightAuto path — on unchanged fences.
const HIGHLIGHT_CACHE_MAX = 64;
const highlightCache = new Map<string, string>();

/**
 * Highlights `code` to HTML using a real grammar when the language is known,
 * falling back to auto-detection otherwise. Input is HTML-escaped by
 * highlight.js, so the result is safe to inject via dangerouslySetInnerHTML.
 *
 * `live` marks a fence that is still streaming. Its text grows every token, so
 * each render is a new cache key: caching it would push every settled fence
 * out of the LRU within one reply, and an unlabeled live fence would re-run
 * `highlightAuto` across every grammar per token. A live fence skips the cache
 * and auto-detection; it gets its full highlighting once the turn settles.
 */
export function highlightToHtml(
  code: string,
  language?: string | null,
  { live = false }: { live?: boolean } = {},
): string {
  ensureRegistered();
  const plain = isPlainLanguage(language);
  const resolved = plain ? null : resolveLanguage(language);
  if (live) {
    return resolved
      ? hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value
      : escapeHtml(code);
  }
  const key = `${resolved ?? (plain ? "plain" : "auto")}\u0000${code}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) {
    highlightCache.delete(key);
    highlightCache.set(key, cached);
    return cached;
  }
  const value = resolved
    ? hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value
    : plain
      ? escapeHtml(code)
      : autoHighlight(code);
  highlightCache.set(key, value);
  if (highlightCache.size > HIGHLIGHT_CACHE_MAX) {
    highlightCache.delete(highlightCache.keys().next().value!);
  }
  return value;
}
