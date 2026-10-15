/**
 * An agent-written PDF, framed from a `data:application/pdf` URL.
 *
 * Deliberately NOT sandboxed. Chrome refuses to run its PDF viewer in any
 * sandboxed frame — `sandbox=""`, `allow-scripts`, and `allow-scripts
 * allow-same-origin` all render the "blocked" page (checked in Chrome on
 * 2026-10-15) — and `<object>`/`<embed>` take no sandbox at all. So the
 * defence in depth comes from the URL scheme instead:
 *
 * - A `data:` document has an opaque origin. It cannot reach the app's DOM,
 *   storage, or cookies, and it is cross-site to the app, so a form post or
 *   link it fires at the backend carries no SameSite session cookie.
 * - Being cross-origin, it falls under the browsers' frame-busting rule: it
 *   cannot navigate the top-level page without a user gesture.
 * - A `blob:` URL would lose all of that — it inherits the app's origin — so
 *   it is not used here even though it avoids building a large string.
 *
 * `no-referrer` keeps the app's URL (thread and artifact ids) out of any
 * request the viewer makes for a link the document contains.
 */
const PDF_DATA_URL_PREFIX = "data:application/pdf;";

export function PdfFrame({ src, title }: { src: string; title: string }) {
  // The guarantees above hold only for a data: URL, so nothing else is framed.
  if (!src.startsWith(PDF_DATA_URL_PREFIX)) return null;
  return (
    <iframe
      className="artifact-frame-preview"
      title={title}
      src={src}
      referrerPolicy="no-referrer"
    />
  );
}
