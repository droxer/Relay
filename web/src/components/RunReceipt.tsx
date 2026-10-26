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
 * The ledger a finished turn closes with — the same rows in the same order on
 * every turn, figures in tabular digits. It stays in ink: only a failure takes
 * a colour (crimson), so a column of receipts reads calm until one is not.
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

  return (
    <section className="run-receipt" data-outcome={receipt.outcome} aria-label={t("thread.receipt.label")}>
      <p className="run-receipt-head">{outcome}</p>
      <dl className="run-receipt-rows">
        {receipt.durationMs !== null ? (
          <>
            <dt>{t("thread.receipt.duration")}</dt>
            <dd>{formatRunDuration(receipt.durationMs)}</dd>
          </>
        ) : null}
        <dt>{t("thread.receipt.tokens")}</dt>
        {receipt.tokens ? (
          <dd title={breakdown}>
            {formatCompactTokens(receipt.tokens.fresh, i18n.language)}
            {receipt.tokens.cached > 0 ? (
              <span className="run-receipt-aside">
                {" · "}
                {t("thread.receipt.tokens_cached", { cached: formatCompactTokens(receipt.tokens.cached, i18n.language) })}
              </span>
            ) : null}
          </dd>
        ) : (
          <dd className="run-receipt-aside">{t("thread.receipt.tokens_unreported")}</dd>
        )}
        {receipt.files > 0 ? (
          <>
            <dt>{t("thread.receipt.files")}</dt>
            <dd>{t("thread.receipt.files_count", { count: receipt.files })}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
