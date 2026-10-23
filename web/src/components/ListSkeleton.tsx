const DEFAULT_ROWS = 6;

/**
 * A list's loading state drawn in the list's own shape — a pip, a title bar,
 * and a trailing meta bar per row — so the page holds its layout and the
 * rows that arrive settle into place instead of replacing a sentence. The
 * bars breathe (list-skeleton.css); the label is what a screen reader hears.
 */
export function ListSkeleton({ label, rows = DEFAULT_ROWS }: { label: string; rows?: number }) {
  return (
    <div className="list-skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="list-skeleton-row" key={index} aria-hidden="true">
          <span className="list-skeleton-pip" />
          <span className="list-skeleton-bar" />
          <span className="list-skeleton-bar list-skeleton-meta" />
        </div>
      ))}
    </div>
  );
}
