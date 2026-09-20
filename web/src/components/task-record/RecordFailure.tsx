"use client";

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/**
 * One failure grammar for the record's panels.
 *
 * The activity tab used to hold three different ones: a silent `null`, and
 * two dead-end `role="alert"` lines with no way out — while the Files tab
 * next to it offered Retry through `WorkspaceError`. A panel that fails
 * inside a tab is not a failed page, so it gets a line rather than
 * `WorkspaceError`'s full-pane block, but it gets the retry.
 *
 * `RecordResultLine` stays deliberately silent on failure: it is a summary of
 * what the history and artifact lists below it already state, so a banner
 * there would report the same outage twice.
 */
export function RecordFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <p className="record-failure" role="alert">
      <span>{message}</span>
      <Button variant="ghost" size="dense" type="button" onClick={onRetry}>
        {t("workspace.retry")}
      </Button>
    </p>
  );
}
