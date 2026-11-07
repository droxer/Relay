// Shared filename → kind classification for every file preview surface
// (workspace file preview, artifact render mode). Lives in lib/ — not in
// components/CodeView.tsx — so the NodeNext test build can import it; .tsx
// components are out of reach there.

// Map a file extension to a highlight.js language id (display label doubles as
// the grammar hint via the aliases in lib/syntax). Exported so tests can
// verify every value here actually resolves through lib/syntax's registry —
// the two tables are maintained independently and nothing else catches drift
// if one changes without the other.
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  json: "json",
  jsonc: "json",
  yml: "yaml",
  yaml: "yaml",
  ini: "ini",
  toml: "ini",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  svg: "xml",
  xml: "xml",
  sql: "sql",
  dockerfile: "dockerfile",
};

const MARKDOWN_EXTENSIONS: Record<string, true> = { md: true, markdown: true };
const HTML_EXTENSIONS: Record<string, true> = { html: true, htm: true };

// MIME types for images the preview can render inline. SVG is text on the
// wire and safe as an <img> — scripts never run in that context.
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Highlight.js language id for a file, or null when unknown. */
export function languageForFile(name: string): string | null {
  return LANGUAGE_BY_EXTENSION[extensionOf(name)] ?? null;
}

/** Whether a file renders to a Markdown preview. */
export function isMarkdownFile(name: string): boolean {
  return MARKDOWN_EXTENSIONS[extensionOf(name)] === true;
}

/** Whether a file renders to an HTML document preview. */
export function isHtmlFile(name: string): boolean {
  return HTML_EXTENSIONS[extensionOf(name)] === true;
}

/** Whether a file has a rendered ("presentation") preview in addition to source. */
export function isRenderableFile(name: string): boolean {
  return isMarkdownFile(name) || isHtmlFile(name) || extensionOf(name) === "svg";
}

/** MIME type for an image file the preview can show inline, or null. */
export function imageMimeForFile(name: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[extensionOf(name)] ?? null;
}

/** Whether a file renders to an inline PDF document preview. */
export function isPdfFile(name: string): boolean {
  return extensionOf(name) === "pdf";
}
