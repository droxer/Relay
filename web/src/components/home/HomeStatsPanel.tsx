"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { HomeStatsPeriod, HomeStatsResponse } from "../../api-client/home";
import { formatCompact } from "../../lib/compactNumber";
import { formatStatsWindow, HOME_STATS_PERIODS, summarizeTopRuntimes } from "../../lib/homeStats";
import { HomeLink } from "./HomePanels";

export interface HomeStatsPanelProps {
  period: HomeStatsPeriod;
  onPeriodChange: (period: HomeStatsPeriod) => void;
  stats: HomeStatsResponse | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  onRetry: () => void;
  tasksHref: string;
  threadsHref: string;
  onOpenTasks: () => void;
  onOpenThreads: () => void;
}

/** Row 1 of Home's 12-column grid: 4 equal tonal stat panels (span 3 each),
 *  pure type without icons-in-circles or inline sparklines. */
export function HomeStatsPanel({
  period,
  onPeriodChange,
  stats,
  isLoading,
  isFetching,
  isError,
  onRetry,
  tasksHref,
  threadsHref,
  onOpenTasks,
  onOpenThreads,
}: HomeStatsPanelProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";

  const topRuntimes = useMemo(
    () => (stats ? summarizeTopRuntimes(stats.runs.runtimes, locale) : null),
    [stats, locale],
  );
  const windowLabel = useMemo(
    () => (stats ? formatStatsWindow(stats.startDate, stats.endDate, locale) : null),
    [stats, locale],
  );

  const tasksMeta = stats
    ? period === "all"
      ? t("home.stats.tasks_meta_all", {
          open: formatCompact(stats.tasks.open, locale),
          inProgress: formatCompact(stats.tasks.inProgress, locale),
        })
      : t("home.stats.tasks_meta", {
          created: formatCompact(stats.tasks.created, locale),
          open: formatCompact(stats.tasks.open, locale),
        })
    : null;

  const conversationsMeta = stats
    ? t("home.stats.conversations_meta", {
        project: formatCompact(stats.conversations.projectChats, locale),
        standalone: formatCompact(stats.conversations.standaloneChats, locale),
      })
    : null;

  const runsMeta = stats
    ? topRuntimes && topRuntimes.items.length > 0
      ? [
          ...topRuntimes.items.map((item) => `${item.label} ${item.formatted}`),
          ...(topRuntimes.remainingRuns > 0
            ? [t("home.stats.runs_more", { count: topRuntimes.remainingRuns })]
            : []),
        ].join(" · ")
      : stats.runs.total === 0
        ? t("home.stats.no_runs")
        : t("home.stats.runs_activity_meta", {
            task: formatCompact(stats.conversations.taskRuns, locale),
            automation: formatCompact(stats.conversations.automationRuns, locale),
          })
    : null;

  const hasTokenCounts = Boolean(stats && (stats.tokens.fresh > 0 || stats.tokens.cacheRead > 0));
  const tokensMeta = stats
    ? hasTokenCounts
      ? t("home.stats.tokens_meta", {
          input: formatCompact(stats.tokens.input, locale),
          output: formatCompact(stats.tokens.output, locale),
        })
      : stats.runs.unreported > 0
        ? t("home.stats.tokens_unreported", { count: stats.runs.unreported })
        : t("home.stats.tokens_empty")
    : null;

  const tokenTitle = stats && hasTokenCounts
    ? t("home.stats.tokens_tooltip", {
        input: formatCompact(stats.tokens.input, locale),
        output: formatCompact(stats.tokens.output, locale),
        cacheWrite: formatCompact(stats.tokens.cacheWrite, locale),
        cacheRead: formatCompact(stats.tokens.cacheRead, locale),
      })
    : undefined;

  const renderValue = (value: number | undefined) => {
    if (value !== undefined) {
      return <span className="home-stat-value tnum">{formatCompact(value, locale)}</span>;
    }
    if (isLoading) {
      return <span className="home-stat-skeleton" aria-hidden="true" />;
    }
    return <span className="home-stat-missing" aria-label={t("home.stats.unavailable")}>—</span>;
  };

  return (
    <section className="home-stats-band" aria-labelledby="home-stats-title">
      <header className="home-band-bar">
        <div className="home-band-heading">
          <h2 id="home-stats-title" className="home-section-title">{t("home.stats.title")}</h2>
          {windowLabel ? <span className="home-section-count tnum">{windowLabel}</span> : null}
        </div>
        <div
          className="home-stats-periods"
          role="group"
          aria-label={t("home.stats.period_label")}
        >
          {HOME_STATS_PERIODS.map((option) => (
            <button
              key={option}
              type="button"
              className="home-stats-period"
              aria-pressed={period === option}
              onClick={() => onPeriodChange(option)}
            >
              {t(`home.stats.period_${option}`)}
            </button>
          ))}
        </div>
      </header>
      {isError && !stats ? (
        <div className="home-card home-stats-error" role="status">
          <span>{t("home.stats.error")}</span>
          <Button type="button" variant="ghost" size="dense" onClick={onRetry}>
            {t("home.plan.retry")}
          </Button>
        </div>
      ) : (
        <div
          className="home-stats-row"
          data-updating={isFetching && stats ? "true" : undefined}
        >
          <HomeLink className="home-card home-stat-card home-stat-link" href={tasksHref} onOpen={onOpenTasks}>
            <span className="home-stat-label">{t("home.stats.tasks_completed")}</span>
            {renderValue(stats?.tasks.completed)}
            <span className="home-stat-meta">
              {tasksMeta ?? (isLoading ? <span className="home-stat-meta-skeleton" aria-hidden="true" /> : "\u00a0")}
            </span>
          </HomeLink>

          <HomeLink className="home-card home-stat-card home-stat-link" href={threadsHref} onOpen={onOpenThreads}>
            <span className="home-stat-label">{t("home.stats.conversations")}</span>
            {renderValue(stats?.conversations.chats)}
            <span className="home-stat-meta">
              {conversationsMeta ?? (isLoading ? <span className="home-stat-meta-skeleton" aria-hidden="true" /> : "\u00a0")}
            </span>
          </HomeLink>

          <HomeLink className="home-card home-stat-card home-stat-link" href={threadsHref} onOpen={onOpenThreads}>
            <span className="home-stat-label">{t("home.stats.agent_runs")}</span>
            {renderValue(stats?.runs.total)}
            <span className="home-stat-meta">
              {runsMeta ?? (isLoading ? <span className="home-stat-meta-skeleton" aria-hidden="true" /> : "\u00a0")}
            </span>
          </HomeLink>

          <div className="home-card home-stat-card" title={tokenTitle}>
            <span className="home-stat-label">{t("home.stats.tokens")}</span>
            {renderValue(stats?.tokens.fresh)}
            <span className="home-stat-meta">
              {tokensMeta ?? (isLoading ? <span className="home-stat-meta-skeleton" aria-hidden="true" /> : "\u00a0")}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
