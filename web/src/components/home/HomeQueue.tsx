"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HomeItem, HomeTier } from "../../lib/homeQueue";
import { HomeQueueItem, type HomeQueueItemProps } from "./HomeQueueItem";
import type { HomeActions } from "./useHomeActions";

const FILTERS = ["all", "needs_you", "other"] as const;
type QueueFilter = (typeof FILTERS)[number];

const needsYou = (item: HomeItem) => item.tier === "paused" || item.tier === "needs_you";
const MATCHES: Record<QueueFilter, (item: HomeItem) => boolean> = {
  all: () => true,
  needs_you: needsYou,
  other: (item) => !needsYou(item),
};

export interface HomeQueueProps {
  items: readonly HomeItem[];
  actions: HomeActions;
  agentName: HomeQueueItemProps["agentName"];
  projectName: HomeQueueItemProps["projectName"];
  sinceLabel: (iso: string) => string;
  hrefFor: (item: HomeItem) => string;
  onOpen: (item: HomeItem) => void;
  allTasksHref: string;
  onOpenAllTasks: () => void;
}

/** "Up next": the ranked queue, banded by tier, with a filter for the
 *  items that hold someone's work up. A row whose own action landed leaves at
 *  once; the next data refresh confirms it. */
export function HomeQueue({ items, actions, agentName, projectName, sinceLabel, hrefFor, onOpen, allTasksHref, onOpenAllTasks }: HomeQueueProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());
  const live = useMemo(() => items.filter((item) => !resolved.has(`${item.key}@${item.stamp}`)), [items, resolved]);
  const shown = live.filter(MATCHES[filter]);
  const bands = bandsOf(shown);

  return (
    <section className="home-section home-queue" aria-labelledby="home-queue-title">
      <header className="home-section-header">
        <h2 id="home-queue-title" className="home-section-title">{t("home.up_next")}</h2>
        <span className="home-section-count tnum">{live.length}</span>
      </header>
      <div className="home-panel">
        <div className="home-filters" role="group" aria-label={t("home.filter_label")}>
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              className="home-filter"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(`home.filter.${value}`)}
              <span className="home-filter-count tnum">{live.filter(MATCHES[value]).length}</span>
            </button>
          ))}
        </div>
        {bands.length === 0 ? (
          <div className="home-clear" role="status">
            <p className="home-clear-title">{t(filter === "all" ? "home.clear_title" : "home.clear_filtered")}</p>
            <p className="home-clear-body">{t("home.clear_body")}</p>
          </div>
        ) : (
          bands.map(({ tier, members }) => (
            <div key={tier} className="home-band" role="group" aria-labelledby={`home-band-${tier}`}>
              <h3 id={`home-band-${tier}`} className="home-band-title">{t(`home.tier.${tier}`)}</h3>
              <ul className="home-items">
                {members.map((item) => (
                  <HomeQueueItem
                    key={item.key}
                    item={item}
                    actions={actions}
                    agentName={agentName}
                    projectName={projectName}
                    since={sinceLabel(item.since)}
                    href={hrefFor(item)}
                    onOpen={() => onOpen(item)}
                    onResolved={() => setResolved((current) => new Set([...current, `${item.key}@${item.stamp}`]))}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
        <footer className="home-panel-footer">
          <span>{t("home.ranked_hint")}</span>
          <a
            className="home-link"
            href={allTasksHref}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onOpenAllTasks();
            }}
          >
            {t("home.all_tasks")}
          </a>
        </footer>
      </div>
    </section>
  );
}

function bandsOf(items: readonly HomeItem[]): { tier: HomeTier; members: HomeItem[] }[] {
  const bands: { tier: HomeTier; members: HomeItem[] }[] = [];
  for (const item of items) {
    const last = bands.at(-1);
    if (last?.tier === item.tier) {
      bands[bands.length - 1] = { tier: last.tier, members: [...last.members, item] };
    } else {
      bands.push({ tier: item.tier, members: [item] });
    }
  }
  return bands;
}
