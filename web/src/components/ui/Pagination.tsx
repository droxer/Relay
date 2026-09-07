"use client";

import { useTranslation } from "react-i18next";

import { pageNumbers, type Page } from "../../lib/pagination";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "@/components/ui/button";
import { ICON, PageNext, PagePrevious } from "../icons";

/**
 * The pager under a list or card grid.
 *
 * It renders NOTHING when everything fits on one page — a "Page 1 of 1" with
 * two dead arrows is chrome that only ever reports its own irrelevance. The
 * range readout ("1–25 of 84") is the part that earns its place on every
 * page: it is the only thing on screen that says how much the reader is not
 * looking at.
 *
 * Take `page` straight from `paginate`, not from the URL — it is clamped, so
 * the highlighted button always matches the rows above it.
 */
export function Pagination<T>({
  page,
  onPageChange,
  label,
  className,
  compact = false,
}: {
  page: Page<T>;
  onPageChange: (page: number) => void;
  /** Names the collection for assistive tech, e.g. "Tasks". */
  label: string;
  className?: string;
  /**
   * Drop the numbered buttons, keeping the range and the two steps. For a
   * narrow container — a board lane — where a row of page numbers does not
   * fit. They are not hidden with CSS: a visually-hidden button is still a
   * tab stop, so a keyboard user would walk through controls nobody can see.
   */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const narrow = useMediaQuery("(max-width: 820px)");
  const isCompact = compact || narrow;
  if (!page.needed) return null;

  const numbers = isCompact ? [] : pageNumbers(page.page, page.pageCount);

  return (
    <nav
      className={className ? `list-pager ${className}` : "list-pager"}
      aria-label={t("list.pagination_label", { collection: label })}
    >
      <p className="list-pager-range" aria-live="polite">
        {isCompact
          // No numbers to read the position off, so the range has to carry it.
          ? t("list.pagination_range_compact", { page: page.page, pageCount: page.pageCount, total: page.total })
          : t("list.pagination_range", { from: page.from, to: page.to, total: page.total })}
      </p>
      <div className="list-pager-controls">
        <Button
          type="button"
          variant="ghost"
          className="list-pager-step"
          disabled={page.page <= 1}
          onClick={() => onPageChange(page.page - 1)}
          aria-label={t("list.pagination_previous")}
        >
          <PagePrevious size={ICON.sm} aria-hidden="true" />
        </Button>
        {numbers.map((entry, index) =>
          entry === "gap" ? (
            // Presentational: a screen reader announcing "ellipsis" between
            // two page buttons adds nothing the numbers do not already say.
            <span key={`gap-${index}`} className="list-pager-gap" aria-hidden="true">…</span>
          ) : (
            <Button
              key={entry}
              type="button"
              variant="ghost"
              className="list-pager-page"
              data-active={entry === page.page ? "true" : "false"}
              aria-current={entry === page.page ? "page" : undefined}
              onClick={() => onPageChange(entry)}
              aria-label={t("list.pagination_page", { page: entry })}
            >
              <span className="tnum">{entry}</span>
            </Button>
          ),
        )}
        <Button
          type="button"
          variant="ghost"
          className="list-pager-step"
          disabled={page.page >= page.pageCount}
          onClick={() => onPageChange(page.page + 1)}
          aria-label={t("list.pagination_next")}
        >
          <PageNext size={ICON.sm} aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
