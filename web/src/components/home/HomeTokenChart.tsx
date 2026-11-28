"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HomeTokenStats } from "../../api-client/home";
import { formatChartDate } from "../../lib/chartDate";
import { formatCompact } from "../../lib/compactNumber";
import { chartLabelIndices, niceTokenScale } from "../../lib/homeStats";

export interface HomeTokenChartProps {
  tokens: HomeTokenStats | undefined;
  isLoading: boolean;
  isError: boolean;
}

const EMPTY_BUCKETS = [] as const;

/** Daily fresh token usage column chart in Relay's single data hue (--tag-2).
 *  Uses real HTML typography for y-ticks and x-labels so text stays a true 12px
 *  from 320px phones to 1440px desktops, with tap + hover + keyboard inspection. */
export function HomeTokenChart({ tokens, isLoading, isError }: HomeTokenChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const [activeBucket, setActiveBucket] = useState<{ date: string; size: HomeTokenStats["bucketSize"] } | null>(null);

  const daily = tokens?.daily ?? EMPTY_BUCKETS;
  const bucketSize = tokens?.bucketSize ?? "day";
  const scale = useMemo(
    () => niceTokenScale(daily.map((day) => day.fresh), 4),
    [daily],
  );
  const wideLabels = useMemo(
    () => new Set(chartLabelIndices(daily.length, 6)),
    [daily.length],
  );
  const narrowLabels = useMemo(
    () => new Set(chartLabelIndices(daily.length, 4)),
    [daily.length],
  );

  const activeDay = activeBucket?.size === bucketSize
    ? daily.find(day => day.date === activeBucket.date)
    : undefined;

  const formatTick = (value: number) => (value === 0 ? "0" : formatCompact(value, locale));

  const headerNote = activeDay
    ? t("home.stats.chart_day_readout", {
        date: formatChartDate(activeDay.date, locale, bucketSize),
        fresh: formatCompact(activeDay.fresh, locale),
        input: formatCompact(activeDay.input, locale),
        output: formatCompact(activeDay.output, locale),
      })
    : tokens && tokens.cacheRead > 0
      ? t("home.stats.chart_cache_note", { cacheRead: formatCompact(tokens.cacheRead, locale) })
      : tokens
        ? t("home.stats.chart_fresh_note")
        : null;

  const ticksDesc = [...scale.ticks].reverse();

  return (
    <section className="home-card home-chart-card" aria-labelledby="home-token-chart-title">
      <header className="home-card-header">
        <div className="home-card-heading">
          <h2 id="home-token-chart-title" className="home-card-title">{t("home.stats.chart_title")}</h2>
        </div>
        {headerNote ? <span className="home-card-note tnum">{headerNote}</span> : null}
      </header>

      {isLoading && !tokens ? (
        <div className="home-chart-skeleton" aria-hidden="true" />
      ) : isError && !tokens ? (
        <p className="home-card-empty">{t("home.stats.error")}</p>
      ) : (
        <>
          <div className="home-chart-body">
            <div
              className="home-chart-frame"
              role="img"
              aria-label={t("home.stats.chart_aria")}
              onMouseLeave={() => setActiveBucket(null)}
            >
              <div className="home-chart-yaxis" aria-hidden="true">
                {ticksDesc.map((tick) => (
                  <span key={tick} className="home-chart-tick tnum">{formatTick(tick)}</span>
                ))}
              </div>

              <div className="home-chart-main">
                <div className="home-chart-plot">
                  <div className="home-chart-grid" aria-hidden="true">
                    {ticksDesc.map((tick) => (
                      <span
                        key={tick}
                        className={tick === 0 ? "home-chart-baseline" : "home-chart-gridline"}
                      />
                    ))}
                  </div>
                  <div className="home-chart-bars">
                    {daily.map((day) => {
                      const ratio = scale.max > 0 ? Math.min(1, day.fresh / scale.max) : 0;
                      const isActive = activeDay?.date === day.date;
                      const isDimmed = !!activeDay && !isActive;
                      const inspect = () => setActiveBucket({ date: day.date, size: bucketSize });
                      const dateLabel = formatChartDate(day.date, locale, bucketSize);
                      const aria = t("home.stats.chart_day_readout", {
                        date: dateLabel,
                        fresh: formatCompact(day.fresh, locale),
                        input: formatCompact(day.input, locale),
                        output: formatCompact(day.output, locale),
                      });
                      return (
                        <button
                          key={day.date}
                          type="button"
                          className="home-chart-col"
                          aria-label={aria}
                          aria-pressed={isActive}
                          onMouseEnter={inspect}
                          onFocus={inspect}
                          onBlur={() => setActiveBucket(null)}
                          onClick={() => isActive ? setActiveBucket(null) : inspect()}
                        >
                          {day.fresh > 0 ? (
                            <span
                              className="home-chart-bar"
                              style={{ height: `${Math.max(2, ratio * 100)}%` }}
                              data-active={isActive ? "true" : undefined}
                              data-dim={isDimmed ? "true" : undefined}
                            />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {daily.length > 0 ? (
                  <div className="home-chart-xaxis" aria-hidden="true">
                    {daily.map((day, index) => {
                      const showWide = wideLabels.has(index);
                      const showNarrow = narrowLabels.has(index);
                      const edge = index === 0 ? "start" : index === daily.length - 1 ? "end" : undefined;
                      return (
                        <span
                          key={day.date}
                          className="home-chart-axis"
                          data-wide={showWide ? "true" : undefined}
                          data-narrow={showNarrow ? "true" : undefined}
                          data-edge={edge}
                        >
                          {showWide || showNarrow ? formatChartDate(day.date, locale, bucketSize) : ""}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
            {tokens && !tokens.available ? (
              <p className="home-chart-empty-note">{t("home.stats.chart_empty")}</p>
            ) : null}
          </div>
          {tokens && tokens.available ? (
            <footer className="home-chart-footer tnum">
              <span>{t("home.stats.chart_breakdown_input", { count: formatCompact(tokens.input, locale) })}</span>
              <span>{t("home.stats.chart_breakdown_output", { count: formatCompact(tokens.output, locale) })}</span>
              <span>{t("home.stats.chart_breakdown_cache_write", { count: formatCompact(tokens.cacheWrite, locale) })}</span>
            </footer>
          ) : null}
        </>
      )}
    </section>
  );
}
