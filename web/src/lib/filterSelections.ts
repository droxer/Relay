/**
 * The seam between Relay's filter state and ReUI's filter query.
 *
 * Relay keeps one value per filter field, in the URL ("" = not filtering on
 * it). ReUI's chips edit a query tree: rules with an operator, in groups. A
 * flat store can hold exactly one kind of rule per field — `is` for a choice,
 * `contains` for text, top level, not negated — so that is all this reads back.
 *
 * The shapes below are the structural subset of ReUI's FilterQuery this needs,
 * kept local so the mapping stays a plain module the node tests can load.
 */
export type SelectionKind = "select" | "text";

export interface SelectionField {
  id: string;
  kind: SelectionKind;
}

/** Field id → value; "" when the field is not filtered. */
export type FilterSelections = Readonly<Record<string, string>>;

export interface SelectionRule {
  id: string;
  type: "rule";
  path: string[];
  operator: string;
  value: unknown;
  negated?: boolean;
}

export interface SelectionGroup {
  id: string;
  type: "group";
  combinator: "and" | "or";
  rules: (SelectionRule | SelectionGroup)[];
}

export type SelectionQuery = SelectionGroup;

/** What `reconcileQuery` builds: one level of rules, no groups. */
export interface FlatSelectionQuery extends Omit<SelectionGroup, "rules"> {
  rules: SelectionRule[];
}

export const SELECTION_OPERATOR: Record<SelectionKind, string> = { select: "is", text: "contains" };

export const EMPTY_FILTER_QUERY: SelectionQuery = { id: "root", type: "group", combinator: "and", rules: [] };

function fieldOf(rule: SelectionRule, fields: readonly SelectionField[]): SelectionField | undefined {
  return rule.path.length === 1 ? fields.find((field) => field.id === rule.path[0]) : undefined;
}

/** A rule the flat store can hold: known field, its one operator, a value. */
function storedValue(rule: SelectionRule, fields: readonly SelectionField[]): string | null {
  const field = fieldOf(rule, fields);
  if (!field || rule.negated || rule.operator !== SELECTION_OPERATOR[field.kind]) return null;
  return typeof rule.value === "string" && rule.value !== "" ? rule.value : null;
}

function isUnfinished(rule: SelectionRule): boolean {
  return rule.operator === "" || rule.value === undefined || rule.value === "";
}

function topLevelRules(query: SelectionQuery): SelectionRule[] {
  return query.rules.filter((node): node is SelectionRule => node.type === "rule");
}

export function selectionsFromQuery(query: SelectionQuery, fields: readonly SelectionField[]): Record<string, string> {
  const selections: Record<string, string> = Object.fromEntries(fields.map((field) => [field.id, ""]));
  for (const rule of topLevelRules(query)) {
    const value = storedValue(rule, fields);
    if (value !== null) selections[rule.path[0]] = value;
  }
  return selections;
}

/**
 * The query the chips should show for `selections`, keeping what `draft`
 * already has where it agrees: a stored rule keeps its id (so its chip is not
 * remounted mid-interaction), and a rule the reader is still building stays,
 * though the store cannot hold it yet. Everything else follows the store, so
 * a Clear or a pasted URL moves the chips.
 */
export function reconcileQuery(
  draft: SelectionQuery,
  selections: FilterSelections,
  fields: readonly SelectionField[],
): FlatSelectionQuery {
  const kept: SelectionRule[] = [];
  const shown = new Set<string>();
  for (const rule of topLevelRules(draft)) {
    const field = fieldOf(rule, fields);
    if (!field) continue;
    const value = storedValue(rule, fields);
    if (value !== null) {
      if (selections[field.id] === value && !shown.has(field.id)) {
        kept.push(rule);
        shown.add(field.id);
      }
    } else if (isUnfinished(rule) && !rule.negated) {
      kept.push(rule);
    }
  }
  const added: SelectionRule[] = fields
    .filter((field) => (selections[field.id] ?? "") !== "" && !shown.has(field.id))
    .map((field) => ({
      id: `${field.id}-selection`,
      type: "rule",
      path: [field.id],
      operator: SELECTION_OPERATOR[field.kind],
      value: selections[field.id],
    }));
  return { ...draft, combinator: "and", rules: [...kept, ...added] };
}

/* Page filter state says "not filtering" with "all" for a choice and "" for
   text; selections say it with "" for both. */
const ALL = "all";

export function selectionsFromState<K extends string>(
  state: Readonly<Record<K, string>>,
  keys: readonly K[],
): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, state[key] === ALL ? "" : state[key]]));
}

export function stateFromSelections<K extends string>(
  selections: FilterSelections,
  keys: readonly K[],
  textKeys: readonly K[] = [],
): Record<K, string> {
  return Object.fromEntries(
    keys.map((key) => [key, selections[key] || (textKeys.includes(key) ? "" : ALL)]),
  ) as Record<K, string>;
}
