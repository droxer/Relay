import { useId, type ElementType, type ReactNode } from "react";
import { RelayMark } from "./RelayMark";
import {
  NavAgents, NavTeams, NavProjects, NavSkills, NavBacklog,
  NavThreads, NavComputer, NavRoutine, ICON,
} from "./icons";
import { cn } from "@/lib/utils";

/** Shared first-use and zero-data surface. Feature marks reuse the navigation
 * vocabulary; supplied illustrations always take precedence. */
const FEATURE_MARKS = {
  agents: NavAgents, teams: NavTeams, projects: NavProjects, skills: NavSkills,
  tasks: NavBacklog, threads: NavThreads, computers: NavComputer, routines: NavRoutine,
};

type RelayEmptyStateProps = {
  feature?: keyof typeof FEATURE_MARKS;
  title: string;
  body?: string;
  hint?: ReactNode;
  /** Small label above the title — the landing hero's "New thread" line. */
  kicker?: ReactNode;
  illustration?: ReactNode;
  actions?: ReactNode;
  className?: string;
  titleId?: string;
  /** Heading level for the title (default 2). */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  fill?: boolean;
};

export function RelayEmptyState({
  feature,
  title,
  body,
  hint,
  kicker,
  illustration,
  actions,
  className,
  titleId,
  headingLevel = 2,
  fill = false,
}: RelayEmptyStateProps) {
  const Mark = feature ? FEATURE_MARKS[feature] : RelayMark;
  const generatedTitleId = useId();
  const resolvedTitleId = titleId ?? generatedTitleId;
  const TitleTag = `h${headingLevel}` as ElementType;

  return (
    <section
      className={cn(
        "relay-empty",
        fill && "relay-empty--fill",
        className,
      )}
      aria-labelledby={resolvedTitleId}
    >
      <div className="relay-empty-illustration" aria-hidden="true">
        {illustration ?? (
          <div className="relay-empty-diagram">
            <span className="relay-empty-diagram-node" />
            <span className="relay-empty-avatar"><Mark size={ICON.xl} /></span>
            <span className="relay-empty-diagram-node" />
          </div>
        )}
      </div>
      {kicker ? <div className="relay-empty-kicker">{kicker}</div> : null}
      <TitleTag
        id={resolvedTitleId}
        className="relay-empty-title"
      >
        {title}
      </TitleTag>
      {body ? (
        <p className="relay-empty-body">{body}</p>
      ) : null}
      {hint ? <p className="relay-empty-hint">{hint}</p> : null}
      {actions ? (
        <div className="relay-empty-actions">{actions}</div>
      ) : null}
    </section>
  );
}
