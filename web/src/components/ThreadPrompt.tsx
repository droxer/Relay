"use client";

import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { ChevronDownIcon, ICON, XIcon } from "./icons";

/** Closing a prompt changes presentation only; its owner keeps the draft and
 *  the underlying request stays available through Show. Key by request identity
 *  when a mounted surface can switch to a different prompt. */
export function ThreadPrompt({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation();
  const [closed, setClosed] = useState(false);
  const contentId = useId();
  return (
    <div className="thread-prompt">
      <div className="thread-prompt-controls">
        {closed ? <span className="thread-prompt-label">{title}</span> : null}
        <Button type="button" variant="ghost" size="sm" aria-expanded={!closed}
          aria-controls={contentId} aria-label={t(closed ? "thread_prompt.show" : "thread_prompt.close", { title })}
          onClick={() => setClosed(value => !value)}>
          {closed ? <ChevronDownIcon size={ICON.sm} aria-hidden="true" /> : <XIcon size={ICON.sm} aria-hidden="true" />}
          {t(closed ? "thread_prompt.show_label" : "thread_prompt.close_label")}
        </Button>
      </div>
      <div id={contentId}>{closed ? null : children}</div>
    </div>
  );
}
