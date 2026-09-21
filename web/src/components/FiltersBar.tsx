"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchInput } from "@/components/ui/search-input";
import { readFiltersExpanded, writeFiltersExpanded } from "@/lib/appStorage";
import { ICON } from "./icons";

interface FiltersBarProps {
  ariaLabel: string;
  searchName: string;
  searchLabel: string;
  query: string;
  onQueryChange: (value: string) => void;
  activeCount: number;
  onClear: () => void;
  /** Page-specific filter controls, revealed when the bar is expanded. */
  children?: ReactNode;
  /**
   * Always-visible control alongside the Filters button. The narrow-width sort
   * menu goes here rather than in `children`: on the widths where it is the
   * only way to sort, burying it behind "Show filters" would hide the control
   * that replaced the column headers.
   */
  trailing?: ReactNode;
  defaultExpanded?: boolean;
  /** Compact controls that stay visible when additional filters are collapsed. */
  quickFilters?: ReactNode;
  expandLabel?: string;
}

export function FiltersBar({
  ariaLabel,
  searchName,
  searchLabel,
  query,
  onQueryChange,
  activeCount,
  onClear,
  children,
  trailing,
  defaultExpanded = false,
  quickFilters,
  expandLabel,
}: FiltersBarProps) {
  const { t } = useTranslation();
  // Remembered per page. Read in the initializer: the bar lives inside the
  // authenticated shell, which is never prerendered, so there is no hydration
  // pass to mismatch — and reading late would flash the filters shut.
  const [expanded, setExpanded] = useState(() => readFiltersExpanded(searchName, defaultExpanded));
  const toggleExpanded = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    writeFiltersExpanded(searchName, next);
  }, [expanded, searchName]);

  const actions = (
    <div className="backlog-filter-actions">
      {quickFilters ? null : trailing}
      <Button
        variant="secondary"
        size="sm"
        type="button"
        className="backlog-filter-chip"
        data-active={expanded ? "true" : "false"}
        data-applied={activeCount > 0 ? "true" : "false"}
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        {expanded ? t("backlog.hide_filters") : (expandLabel ?? t("backlog.show_filters"))}
        {activeCount > 0 ? (
          <span className="backlog-filter-count" aria-hidden="true">{activeCount}</span>
        ) : null}
      </Button>
      {activeCount > 0 ? (
        <Button variant="ghost"
          type="button"
          className="backlog-filter-clear"
          onClick={onClear}
        >
          {t("backlog.clear_filters")}
        </Button>
      ) : null}
    </div>
  );

  return (
    <div className="backlog-filter-bar" role="group" aria-label={ariaLabel}>
      <div className="backlog-filter-primary">
        <SearchInput
          className="backlog-filter-search-wrap"
          inputClassName="backlog-filter-search"
          iconSize={ICON.sm}
          label={searchLabel}
          name={searchName}
          value={query}
          placeholder={searchLabel}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {quickFilters ? trailing : actions}
      </div>
      {quickFilters ? <div className="backlog-filter-quick">
        {quickFilters}
        {actions}
      </div> : null}
      {expanded ? (
        <div className="backlog-filter-secondary">{children}</div>
      ) : null}
    </div>
  );
}

/* One dropdown vocabulary. The filter rows used native <select> elements, so
   the popup list was OS chrome — a different surface, radius, type scale, and
   highlight colour from the <Select> popup used everywhere else in the app, and
   untouched by the theme. This wraps the primitive so a filter stays the
   one-liner it was at the call site. */
export function FilterSelect<T extends string>({
  name,
  label,
  value,
  onValueChange,
  options,
  className,
  size = "default",
}: {
  name: string;
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  className?: string;
  /** `sm` when the select shares a row with the compact filter controls. */
  size?: "sm" | "default";
}) {
  return (
    <Select
      value={value}
      /* `items` is what lets the trigger show a label before the popup has ever
         been mounted. Without it Base UI has no value→label map yet and renders
         the raw value, so an unopened filter read "all" instead of "All
         statuses". */
      items={options}
      onValueChange={(next) => {
        if (next == null) return;
        onValueChange(next as T);
      }}
    >
      <SelectTrigger name={name} aria-label={label} size={size} className={className ?? "w-full"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} label={option.label}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
