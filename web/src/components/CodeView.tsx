import { useMemo } from "react";

import { useHighlightedHtml } from "../hooks/useHighlightedHtml";

// The filename → kind classification lives in lib/fileKinds so non-component
// modules (artifactPreview) and the NodeNext test build can share it.
export {
  extensionOf,
  imageMimeForFile,
  isHtmlFile,
  isMarkdownFile,
  isPdfFile,
  isRenderableFile,
  languageForFile,
} from "../lib/fileKinds";

/** Syntax-highlighted code block with a line-number gutter. */
export function CodeView({ code, language }: { code: string; language?: string | null }) {
  const source = code.replace(/\n$/, "");
  const html = useHighlightedHtml(source, language);
  const gutter = useMemo(
    () =>
      Array.from({ length: source.split("\n").length }, (_, index) => index + 1).join("\n"),
    [source],
  );
  return (
    <div className="code-view">
      {language ? <span className="code-view-lang">{language}</span> : null}
      <div className="code-view-scroll">
        <pre className="code-gutter" aria-hidden="true">
          {gutter}
        </pre>
        <pre className="code-body">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    </div>
  );
}
