import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Breadcrumb, type BreadcrumbItem } from "./Breadcrumb";
import { MobileTopbarActions } from "./MobileTopbarSlot";

export function PageHeader({
  title,
  count,
  facts,
  trail,
  kicker,
  subtitle,
  toolbar,
  actions,
  topbarActions = false,
  titleVariant = "default",
  titleAs = "h1",
  layout = "inline",
}: {
  title: ReactNode;
  count?: ReactNode;
  /** Compact record facts riding the title line next to the title, for
   *  surfaces whose facts must not claim a band row above every tab. */
  facts?: ReactNode;
  /** The title's ancestors, drawn as a location trail leading the title. */
  trail?: BreadcrumbItem[];
  kicker?: ReactNode;
  subtitle?: ReactNode;
  toolbar?: ReactNode;
  actions?: ReactNode;
  /** On a phone, move `actions` into the top bar (MobileTopbarActions) instead
   *  of keeping a header band for them. `true` for a list surface's own
   *  header; `"inactive"` where the list stays mounted under its open detail,
   *  so its actions leave the bar. Off by default — record and drawer headers
   *  keep their actions in place. */
  topbarActions?: boolean | "inactive";
  /** "display" is the 28px hero tier for page-owning nouns; "title" is the
   *  19px tier for a fixed UI noun heading a subordinate pane (the thread
   *  rail — same rung a drawer title takes); "record" is regular sans for a
   *  name the user or an agent authored. See shell.css. */
  titleVariant?: "default" | "display" | "title" | "record";
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
          {trail?.length ? <Breadcrumb items={trail} /> : null}
          <TitleTag
            className={cn(
              "page-header-title",
              titleVariant === "display"
                ? "page-header-title--display"
                : titleVariant === "title"
                  ? "page-header-title--title"
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
          {facts ? <div className="page-header-facts">{facts}</div> : null}
        </div>
        {subtitle ? <p className="page-header-subtitle">{subtitle}</p> : null}
        {toolbar ? <div className="page-header-toolbar">{toolbar}</div> : null}
      </div>
      {actions ? (
        topbarActions ? (
          <MobileTopbarActions active={topbarActions !== "inactive"}>
            <div className={cn("page-header-actions", stacked && "page-header-actions--stacked")}>
              {actions}
            </div>
          </MobileTopbarActions>
        ) : (
          <div className={cn("page-header-actions", stacked && "page-header-actions--stacked")}>
            {actions}
          </div>
        )
      ) : null}
    </header>
  );
}
