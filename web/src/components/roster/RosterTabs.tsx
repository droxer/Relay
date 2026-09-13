"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type RosterTab<Id extends string> = {
  id: Id;
  label: string;
  /** Shown beside the label so a roster's size is visible before switching. */
  count: number;
};

/**
 * The roster tab strip every agent / agent-team picker shares.
 *
 * Agents and agent teams are two ROSTERS, not two sections of one list: they
 * are chosen for different reasons, and a popup that stacks them into a single
 * scroll makes the shorter roster disappear under the longer one. So the popup
 * is tabbed — one tab per roster — and the strip replaces the group labels the
 * list used to carry.
 *
 * The strip is chrome, not options, so it renders through `SelectContent`'s
 * `header` slot: inside the popup, outside `Select.List` (the `role="listbox"`,
 * which may only contain options). That also decides the keyboard contract —
 * focus stays inside the popup, so the tabs are not in the tab order and
 * ←/→ switch rosters while ↑/↓ walk the active one. Capture phase,
 * because the listbox's composite handler claims arrow keys first.
 *
 * A surface with only one roster to offer renders NO strip: `header` comes back
 * null and the popup looks like any other select. One tab is not a choice, and
 * a lone tab would imply a second roster that is never coming.
 */
export function useRosterTabs<Id extends string>({
  tabs,
  activeTab,
  label,
}: {
  tabs: RosterTab<Id>[];
  /** The roster the current value belongs to — the popup opens there, so the
   *  checked row is the one on screen. */
  activeTab: Id;
  /** Names the tablist for assistive tech. */
  label: string;
}): {
  tab: Id;
  /** Pass to `SelectContent`'s `header`; null when there is one roster. */
  header: ReactNode | null;
  /** Pass to `SelectContent`'s `onKeyDownCapture`. */
  onKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Call from `onOpenChange(true)` to reopen on the active roster. */
  resetTab: () => void;
} {
  const [tab, setTab] = useState<Id>(activeTab);
  const tabbed = tabs.length > 1;
  // With a single roster the strip is gone, so the state behind it must not
  // decide anything: read the only roster straight off the list.
  const current = tabbed ? tab : tabs[0]?.id ?? activeTab;
  const pendingFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const popup = pendingFocus.current;
    pendingFocus.current = null;
    if (!popup?.isConnected) return;
    const option = popup.querySelector<HTMLElement>(
      '[role="option"]:not([aria-disabled="true"]):not([data-disabled]):not(:disabled)',
    );
    (option ?? popup).focus({ preventScroll: true });
    option?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  function switchTab(next: Id, popup: HTMLElement | null): void {
    if (next === current) return;
    // Select focuses an option, not the listbox. Park focus on the persistent
    // popup before removing that option, then focus the new roster on commit.
    // An empty/disabled roster keeps the popup focused so arrows still work.
    pendingFocus.current = popup;
    popup?.focus({ preventScroll: true });
    setTab(next);
  }

  function onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>): void {
    if (!tabbed) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const index = tabs.findIndex((entry) => entry.id === current);
    const next = event.key === "ArrowRight"
      ? Math.min(index + 1, tabs.length - 1)
      : Math.max(index - 1, 0);
    switchTab(tabs[next]!.id, event.currentTarget);
  }

  return {
    tab: current,
    onKeyDownCapture,
    resetTab: () => setTab(activeTab),
    header: tabbed ? (
      <div className="roster-tabs" role="tablist" aria-label={label}>
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            tabIndex={-1}
            aria-selected={current === entry.id}
            className="roster-tab"
            // Keep focus inside the popup until switchTab transfers it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => switchTab(entry.id, event.currentTarget.closest<HTMLElement>('[data-slot="select-content"]'))}
          >
            <span>{entry.label}</span>
            <span className="roster-tab-count">{entry.count}</span>
          </button>
        ))}
      </div>
    ) : null,
  };
}

/** The active roster's label, for naming the option group a reader lands in. */
export function rosterLabel<Id extends string>(tabs: RosterTab<Id>[], tab: Id): string | undefined {
  return tabs.find((entry) => entry.id === tab)?.label;
}
