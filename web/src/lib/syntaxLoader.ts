/* highlight.js on demand.

   lib/syntax registers 26 grammars at import. It was imported by components on
   the default route (the command lines in an agent stream, the file viewer),
   so every page load shipped and parsed them before anything needed a colour.
   Callers render escaped plain text until the module lands, then highlight. */

type SyntaxModule = typeof import("./syntax");

let loaded: SyntaxModule | null = null;
let pending: Promise<SyntaxModule> | null = null;

export function loadSyntax(): Promise<SyntaxModule> {
  pending ??= import("./syntax").then((module) => {
    loaded = module;
    return module;
  });
  return pending;
}

export function syntaxLoaded(): boolean {
  return loaded !== null;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeCodeHtml(code: string): string {
  return code.replace(/[&<>"']/g, (character) => ESCAPES[character]!);
}

/** Highlighted HTML when the grammars are loaded, escaped plain text before. */
export function highlightIfLoaded(code: string, language?: string | null): string {
  return loaded ? loaded.highlightToHtml(code, language) : escapeCodeHtml(code);
}
