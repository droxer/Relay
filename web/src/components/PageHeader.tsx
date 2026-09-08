import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  count,
  kicker,
  subtitle,
  toolbar,
  actions,
  titleVariant = "default",
  titleAs = "h1",
  layout = "inline",
}: {
  title: ReactNode;
  count?: ReactNode;
  kicker?: ReactNode;
  subtitle?: ReactNode;
  toolbar?: ReactNode;
  actions?: ReactNode;
  /** "display" is medium-weight sans for fixed UI nouns; "record" is regular sans for a name the
   *  user or an agent authored. See .page-header-title--display in shell.css. */
  titleVariant?: "default" | "display" | "record";
  /** Heading level. Nested detail panes (team/agent detail under a roster)
   *  demote to "h2" so the roster title stays the single page h1. */
  titleAs?: "h1" | "h2" | "h3";
  layout?: "inline" | "stacked";
}) {
  const stacked = layout === "stacked";
  const TitleTag = titleAs;

  return (
    <header
      className={cn(
        "page-header surface-header",
        stacked ? "page-header--stacked" : "page-header--inline",
      )}
    >
      <div className={cn("page-header-lead", stacked && "page-header-lead--stacked")}>
        {kicker ? <span className="page-header-kicker">{kicker}</span> : null}
        <div className={cn("page-header-title-row", stacked && "page-header-title-row--wrap")}>
          <TitleTag
            className={cn(
              "page-header-title",
              titleVariant === "display"
                ? "page-header-title--display"
                : titleVariant === "record"
                  ? "page-header-title--record"
                  : "page-header-title--inline",
            )}
          >
            {title}
          </TitleTag>
          {count != null ? (
            <span className="page-header-count">{count}</span>
          ) : null}
        </div>
        {subtitle ? <p className="page-header-subtitle">{subtitle}</p> : null}
        {toolbar ? <div className="page-header-toolbar">{toolbar}</div> : null}
      </div>
      {actions ? (
        <div className={cn("page-header-actions", stacked && "page-header-actions--stacked")}>
          {actions}
        </div>
      ) : null}
    </header>
  );
}
