import { navigateToAppPath } from "./appRoute";

/**
 * Where a record's back affordance goes, and how.
 *
 * A list keeps its filters in the query string (`/routines?state=paused&q=x`),
 * and opening a record leaves that path — so a back control that links to the
 * bare list path silently resets the reader's filters. Browser Back does not,
 * because the filtered URL is still the previous history entry.
 *
 * So: when this session navigated into the record from a list, back IS Back.
 * When the reader arrived by deep link there is no entry to return to, and
 * back is an ordinary link to the list. One helper, so no surface has to
 * decide this for itself — and so neither one gets it wrong.
 */
let lastListUrl: string | null = null;

/** Called by the router just before it pushes a record route. */
export function rememberListUrl(): void {
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  // Only a list is worth returning to; a record opened from another record
  // (a run from its routine) keeps the list the routine came from.
  if (/^\/(backlog|routines)\/?$/.test(pathname)) lastListUrl = `${pathname}${search}`;
}

export function forgetListUrl(): void {
  lastListUrl = null;
}

export function recordBackHref(fallbackPath: string): string {
  return lastListUrl ?? fallbackPath;
}

/** Navigates back, returning true when it consumed the click. */
export function navigateRecordBack(fallbackPath: string): void {
  if (typeof window === "undefined") return;
  if (lastListUrl) {
    window.history.back();
    return;
  }
  void navigateToAppPath(fallbackPath);
}
