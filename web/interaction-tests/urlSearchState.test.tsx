import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUrlSearchState } from "../src/hooks/useUrlSearchState";
import { useUrlFilters } from "../src/hooks/useUrlFilters";
import { registerNavigationGuard } from "../src/lib/navigationGuard";
import { APP_NAVIGATION_EVENT } from "../src/lib/appRoute";
import { BACKLOG_FILTER_SPEC, initialFilters } from "../src/components/task-board/backlogVocabulary";

const CYCLE: Record<string, string> = { profile: "skills", skills: "activities", activities: "profile" };

function setUrl(url: string) {
  window.history.replaceState({}, "", url);
  window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { window.history.replaceState({}, "", "/"); });

describe("useUrlSearchState", () => {
  it("applies a new fallback when parse changes while mounted", () => {
    window.history.replaceState({}, "", "/agents");
    const { result, rerender } = renderHook(
      ({ fallback }) => useUrlSearchState("q", fallback, (value) => value ?? fallback, (value) => value),
      { initialProps: { fallback: "first" } },
    );
    expect(result.current[0]).toBe("first");
    rerender({ fallback: "second" });
    expect(result.current[0]).toBe("second");
  });

  it("follows the URL on navigation and on back/forward", () => {
    window.history.replaceState({}, "", "/agents?q=one");
    const { result } = renderHook(() => useUrlSearchState("q", "", (value) => value ?? "", (value) => value || null));
    expect(result.current[0]).toBe("one");
    act(() => setUrl("/agents?q=two"));
    expect(result.current[0]).toBe("two");
    act(() => {
      window.history.replaceState({}, "", "/agents?q=three");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toBe("three");
  });

  it("composes consecutive functional updates in one handler", () => {
    window.history.replaceState({}, "", "/agents");
    const { result } = renderHook(() => useUrlSearchState("q", "", (value) => value ?? "", (value) => value || null));
    act(() => {
      result.current[1]((current) => `${current}a`);
      result.current[1]((current) => `${current}b`);
    });
    expect(result.current[0]).toBe("ab");
    expect(window.location.search).toBe("?q=ab");
  });

  it("resolves a guarded tab update against the value current when the dialog confirms", async () => {
    window.history.replaceState({}, "", "/agents/one?tab=skills");
    const answer = deferred<boolean>();
    const release = registerNavigationGuard(() => answer.promise);
    const { result } = renderHook(() => useUrlSearchState(
      "tab", "profile", (value) => value ?? "profile", (value) => (value === "profile" ? null : value), "push",
    ));

    act(() => result.current[1]((current) => CYCLE[current]));
    // While the confirm dialog is open, something else moves the tab.
    act(() => setUrl("/agents/one?tab=activities"));
    expect(result.current[0]).toBe("activities");
    await act(async () => { answer.resolve(true); await answer.promise; });

    expect(result.current[0]).toBe("profile");
    expect(window.location.search).toBe("");
    release();
  });
});

const DEFAULT_FILTERS = initialFilters;
const SPEC = BACKLOG_FILTER_SPEC;

describe("useUrlFilters", () => {
  it("applies new defaults while mounted", () => {
    window.history.replaceState({}, "", "/tasks");
    const { result, rerender } = renderHook(
      ({ defaults }) => useUrlFilters(defaults, SPEC),
      { initialProps: { defaults: DEFAULT_FILTERS } },
    );
    expect(result.current[0].status).toBe("all");
    rerender({ defaults: { ...DEFAULT_FILTERS, status: "blocked" } });
    expect(result.current[0].status).toBe("blocked");
  });

  it("keeps an identity-stable value between unrelated renders", () => {
    window.history.replaceState({}, "", "/tasks?q=bug");
    const { result, rerender } = renderHook(() => useUrlFilters(DEFAULT_FILTERS, SPEC));
    const first = result.current[0];
    rerender();
    expect(result.current[0]).toBe(first);
    expect(first.query).toBe("bug");
  });

  it("composes consecutive functional updates and follows navigation", () => {
    window.history.replaceState({}, "", "/tasks");
    const { result } = renderHook(() => useUrlFilters(DEFAULT_FILTERS, SPEC));
    act(() => {
      result.current[1]((current) => ({ ...current, query: `${current.query}a` }));
      result.current[1]((current) => ({ ...current, query: `${current.query}b` }));
    });
    expect(result.current[0].query).toBe("ab");
    expect(new URL(window.location.href).searchParams.get("q")).toBe("ab");
    act(() => setUrl("/tasks?q=zz"));
    expect(result.current[0].query).toBe("zz");
  });
});
