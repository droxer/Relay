"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { shouldRenderDiagram } from "../../lib/markdown";
import { highlightToHtml } from "../../lib/syntax";
import {
  ActionCopy,
  CheckIcon,
  ICON,
} from "../icons";
import { useMarkdownMode } from "./context";
import { MermaidDiagram } from "./MermaidDiagram";
import { Button } from "@/components/ui/button";

function CopyFenceButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleCopy = useCallback(async () => {
    const settle = (ok: boolean) => {
      setCopied(ok);
      setFailed(!ok);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { setCopied(false); setFailed(false); }, 1800);
    };
    try {
      await navigator.clipboard.writeText(text);
      settle(true);
    } catch {
      // Non-secure context or denied permission. The block is selectable, so
      // say so on the control rather than failing silently.
      settle(false);
    }
  }, [text]);

  const label = failed
    ? t("message.copy_code_failed")
    : copied
      ? t("artifact.copied")
      : t("message.copy_code");

  return (
    <Button variant="ghost" type="button" className="md-fence-copy" onClick={handleCopy} aria-label={label}>
      {copied ? <CheckIcon size={ICON.sm} aria-hidden="true" /> : <ActionCopy size={ICON.sm} aria-hidden="true" />}
      <span className="md-fence-copy-label">{label}</span>
    </Button>
  );
}

/**
 * A fenced code block: language caption, syntax highlighting, and a copy
 * control — or, for a diagram dialect, the rendered diagram.
 *
 * The wrapper element is unconditional. Adding it only once a run settles
 * would reshuffle the DOM at exactly the moment the reader is looking at it,
 * and the streaming caret in agent-stream.css hangs off this structure.
 */
export function MarkdownFence({ code, language }: { code: string; language: string | null }) {
  const { live } = useMarkdownMode();

  const fence = (
    <pre className="agent-code code">
      {language ? <span className="agent-code-lang">{language}</span> : null}
      <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightToHtml(code, language, { live }) }} />
    </pre>
  );

  if (shouldRenderDiagram(language, live)) {
    return (
      <div className="md-fence">
        <MermaidDiagram code={code} fallback={fence} />
      </div>
    );
  }

  return (
    <div className="md-fence">
      {fence}
      {/* A live fence is still growing; a copy would capture a partial snippet. */}
      {live ? null : <CopyFenceButton text={code} />}
    </div>
  );
}
