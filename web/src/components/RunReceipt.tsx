import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { RunReceipt as Receipt } from "../lib/runReceipt";
import { formatRunDuration } from "../lib/taskRuns";
import { formatCompactTokens, splitCache } from "../lib/tokenUsage";
import type { TokenUsage } from "../types";

type Props = {
  receipt: Receipt;
  /** The raw counts, for the tokens row's full breakdown on hover. */
  usage?: TokenUsage;
};

/**
 * The one line a finished turn closes with — outcome, duration, tokens, files,
 * always in that order, joined by middle dots in tabular digits. It stays in
 * meta ink: only a failure takes a colour (crimson), so a column of turns
 * reads calm until one is not.
 */
export function RunReceipt({ receipt, usage }: Props) {
  const { t, i18n } = useTranslation();
  const numberFormat = useMemo(() => new Intl.NumberFormat(i18n.language || undefined), [i18n.language]);
  const outcome = receipt.outcome === "failed" && receipt.exitCode
    ? t("thread.receipt.outcome_failed_exit", { code: receipt.exitCode })
    : t(`thread.receipt.outcome_${receipt.outcome}`);
  const breakdown = usage
    ? t("thread.token_usage_title", {
      input: numberFormat.format(usage.input),
      output: numberFormat.format(usage.output),
      cacheWrite: numberFormat.format(splitCache(usage).cacheWrite),
      cacheRead: numberFormat.format(splitCache(usage).cacheRead),
    })
    : undefined;
  const tokens = receipt.tokens
    ? t("thread.receipt.tokens_count", { tokens: formatCompactTokens(receipt.tokens.fresh, i18n.language) })
    : t("thread.receipt.tokens_unreported");

  return (
    <section className="run-receipt" data-outcome={receipt.outcome} aria-label={t("thread.receipt.label")}>
      <span className="run-receipt-outcome">{outcome}</span>
      {receipt.durationMs !== null ? <span>{formatRunDuration(receipt.durationMs)}</span> : null}
      <span title={breakdown}>{tokens}</span>
      {receipt.tokens && receipt.tokens.cached > 0 ? (
        <span>{t("thread.receipt.tokens_cached", { cached: formatCompactTokens(receipt.tokens.cached, i18n.language) })}</span>
      ) : null}
      {receipt.files > 0 ? <span>{t("thread.receipt.files_count", { count: receipt.files })}</span> : null}
    </section>
  );
}
