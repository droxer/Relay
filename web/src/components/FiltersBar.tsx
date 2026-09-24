"use client";

import { useMemo, useState, type ReactNode } from "react";
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
import { Filters } from "@/components/reui/filters/filters";
import { FilterRuleMenuOptionsContext } from "@/components/reui/filters/filters-chip";
import type { FilterField, FilterLabels, FilterQuery } from "@/components/reui/filters/filters-types";
import {
  EMPTY_FILTER_QUERY,
  SELECTION_OPERATOR,
  reconcileQuery,
  selectionsFromQuery,
  type FilterSelections,
  type SelectionKind,
  type SelectionQuery,
} from "@/lib/filterSelections";
import { ICON } from "./icons";

/** One filter a page offers. `select` filters by one of `options`; `text` by a substring. */
export interface FilterBarField {
  id: string;
  label: string;
  kind: SelectionKind;
  options?: readonly { value: string; label: string }[];
}

interface FiltersBarProps {
  /** `band` spans a page above its list; `rail` is a list rail's header band
   *  (.list-filter-bar), which the roster rails share. */
  variant?: "band" | "rail";
  ariaLabel: string;
  searchName: string;
  searchLabel: string;
  /** Defaults to the label. */
  searchPlaceholder?: string;
  query: string;
  onQueryChange: (value: string) => void;
  fields: readonly FilterBarField[];
  /** The page's filter state, one value per field id ("" = not filtering). */
  selections: FilterSelections;
  onSelectionsChange: (next: Record<string, string>) => void;
  /** Clears the bar's own filters and its search — not the section rail, nor a
   *  page-level field (a project, a status) that only rides in the bar. */
  onClear: () => void;
  /** How many filters Clear would clear; defaults to every filtered field. */
  clearableCount?: number;
  /** Always-visible control after the search: the narrow-width sort menu. */
  trailing?: ReactNode;
}

// A flat, URL-backed filter store can hold neither a duplicated rule nor a
// negated one, so the chip menu does not offer them.
const RULE_MENU = { duplicate: false, negate: false } as const;

function useFilterLabels(): Partial<FilterLabels> {
  const { t } = useTranslation();
  return useMemo(() => ({
    addFilter: t("filters.add_filter"),
    addCondition: t("filters.add_filter"),
    searchFields: t("filters.search_fields"),
    searchOperators: t("filters.search_operators"),
    searchOptions: t("filters.search_options"),
    back: t("filters.back"),
    clear: t("filters.clear"),
    apply: t("filters.apply"),
    discard: t("filters.discard"),
    empty: t("filters.empty"),
    loading: t("filters.loading"),
    loadingMore: t("filters.loading_more"),
    loadMore: t("filters.load_more"),
    error: t("filters.error"),
    retry: t("filters.retry"),
    where: t("filters.where"),
    and: t("filters.and"),
    remove: t("filters.remove"),
    chipMenu: (field: string) => t("filters.chip_menu", { field }),
    filtersLabel: t("filters.filters_label"),
    clearAll: t("filters.clear_all"),
    valuePlaceholder: t("filters.value_placeholder"),
    selectPlaceholder: t("filters.select_placeholder"),
    noValue: t("filters.no_value"),
    selectCondition: t("filters.select_condition"),
    incomplete: t("filters.incomplete"),
    branchAffordance: t("filters.branch_affordance"),
    fieldsLabel: t("filters.fields_label"),
    actionsLabel: t("filters.actions_label"),
    itemCount: (count: number) => t("filters.item_count", { count }),
    resultsAnnouncement: (count: number) => t("filters.results", { count }),
    stepAnnouncement: (step, label) => t(
      step === "field" ? "filters.step_field" : step === "operator" ? "filters.step_operator" : "filters.step_value",
      { label },
    ),
    countAnnouncement: (count: number) => t("filters.applied", { count }),
    valueCount: (count: number) => t("filters.value_count", { count }),
    valueDetail: (summary: string, values: string[]) => t("filters.value_detail", { summary, values: values.join(", ") }),
    negated: (operator: string) => t("filters.negated", { operator }),
    issueOperator: t("filters.issue_operator"),
    issueValue: t("filters.issue_value"),
    readOnly: t("filters.read_only"),
  }), [t]);
}

/**
 * Every list's filter band: a search box, then the filters as chips (ReUI
 * Filters) — "Add filter" picks a field, then a value; a chip edits or
 * removes it.
 *
 * The page keeps its filter state as before — one value per field, in the
 * URL — and this bar translates at the edge (lib/filterSelections): a chip
 * the reader is still building lives only here until it has a value, and a
 * change made elsewhere (Clear, the section rail, a pasted link) redraws the
 * chips from that state.
 */
export function FiltersBar({
  variant = "band",
  ariaLabel,
  searchName,
  searchLabel,
  searchPlaceholder,
  query,
  onQueryChange,
  fields,
  selections,
  onSelectionsChange,
  onClear,
  clearableCount,
  trailing,
}: FiltersBarProps) {
  const { t } = useTranslation();
  const labels = useFilterLabels();
  const selectionFields = useMemo(() => fields.map(({ id, kind }) => ({ id, kind })), [fields]);
  const filterFields = useMemo<FilterField<string>[]>(() => fields.map((field) => {
    const operator = SELECTION_OPERATOR[field.kind];
    return {
      id: field.id,
      label: field.label,
      type: field.kind,
      options: field.options?.map((option) => ({ value: option.value, label: option.label })),
      operators: [{ value: operator, label: t(`filters.operator_${operator}`) }],
      defaultOperator: operator,
    };
  }), [fields, t]);
  const [draft, setDraft] = useState<SelectionQuery>(EMPTY_FILTER_QUERY);
  // Derived every render, never synced in an effect: the chips are the draft
  // corrected by the page's state, so outside changes land immediately.
  const shown = reconcileQuery(draft, selections, selectionFields);
  const activeCount = clearableCount ?? Object.values(selections).filter((value) => value !== "").length;

  function changeQuery(next: FilterQuery<string>) {
    const nextQuery = next as unknown as SelectionQuery;
    setDraft(nextQuery);
    const nextSelections = selectionsFromQuery(nextQuery, selectionFields);
    const changed = selectionFields.some((field) => (selections[field.id] ?? "") !== nextSelections[field.id]);
    if (changed) onSelectionsChange(nextSelections);
  }

  const rail = variant === "rail";
  const search = (
    <SearchInput
      className={rail ? "list-filter-search" : "backlog-filter-search-wrap"}
      inputClassName={rail ? undefined : "backlog-filter-search"}
      iconSize={ICON.sm}
      label={searchLabel}
      name={searchName}
      value={query}
      placeholder={searchPlaceholder ?? searchLabel}
      onChange={(event) => onQueryChange(event.target.value)}
    />
  );
  const chips = (
    <div className={rail ? "list-filter-chips" : "backlog-filter-chips"}>
      <FilterRuleMenuOptionsContext.Provider value={RULE_MENU}>
        <Filters<string>
          fields={filterFields}
          query={shown as unknown as FilterQuery<string>}
          onQueryChange={changeQuery}
          labels={labels}
          size="sm"
        />
      </FilterRuleMenuOptionsContext.Provider>
      {activeCount > 0 ? (
        <Button variant="ghost" type="button" className="backlog-filter-clear" onClick={onClear}>
          {t("backlog.clear_filters")}
        </Button>
      ) : null}
    </div>
  );

  if (rail) {
    return (
      <div className="list-filter-bar" data-chips="true" role="group" aria-label={ariaLabel}>
        {search}
        {trailing}
        {chips}
      </div>
    );
  }
  return (
    <div className="backlog-filter-bar" role="group" aria-label={ariaLabel}>
      <div className="backlog-filter-primary">
        {search}
        {trailing}
      </div>
      {chips}
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
