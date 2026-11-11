/** Content-shaped placeholders; the label is the only announced content. */
export function DetailSkeleton({
  label,
  variant = "skill",
}: {
  label: string;
  variant?: "project" | "skill" | "preview" | "file";
}) {
  return (
    <div className={`detail-skeleton detail-skeleton--${variant}`} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">
        {variant === "project" || variant === "skill" ? (
          <div className="detail-skeleton-header">
            <span className="list-skeleton-bar detail-skeleton-title" />
            <span className="list-skeleton-bar detail-skeleton-meta" />
            {variant === "project" ? (
              <div className="detail-skeleton-tabs">
                {Array.from({ length: 6 }, (_, index) => <span className="list-skeleton-bar" key={index} />)}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="detail-skeleton-body">
          {Array.from({ length: variant === "file" ? 1 : 2 }, (_, section) => (
            <div className="detail-skeleton-section" key={section}>
              {variant !== "file" ? <span className="list-skeleton-bar detail-skeleton-heading" /> : null}
              {Array.from({ length: variant === "file" ? 10 : 4 }, (_, line) => (
                <span className="list-skeleton-bar detail-skeleton-line" key={line} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
