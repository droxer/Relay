type NavigationGuard = () => Promise<boolean>;
const guards = new Set<NavigationGuard>();
let navigating = false;

export function registerNavigationGuard(guard: NavigationGuard): () => void {
  guards.add(guard);
  return () => { guards.delete(guard); };
}

async function permitsNavigation(): Promise<boolean> {
  for (const guard of [...guards]) {
    if (guards.has(guard) && !await guard()) return false;
  }
  return true;
}

/** Keep the no-draft path synchronous; several URL controls compose writes. */
export async function requestNavigation(commit: () => void): Promise<void> {
  if (navigating) return;
  if (guards.size === 0) { commit(); return; }
  navigating = true;
  try {
    if (await permitsNavigation()) commit();
  } finally {
    navigating = false;
  }
}

const INDEX = "relayHistoryIndex";

/** Restore a traversed entry before asking, so URL and mounted form stay together. */
export function installNavigationHistory(): () => void {
  const history = window.history;
  const push = history.pushState;
  const replace = history.replaceState;
  let index: number = history.state?.[INDEX] ?? 0;
  let disposed = false;
  let restoring: (() => void) | null = null;
  let replaying = false;
  replace.call(history, { ...history.state, [INDEX]: index }, "");

  history.pushState = function (state, unused, url) {
    push.call(history, { ...state, [INDEX]: index + 1 }, unused, url);
    index += 1;
  };
  history.replaceState = function (state, unused, url) {
    replace.call(history, { ...state, [INDEX]: index }, unused, url);
  };

  const onPop = (event: PopStateEvent) => {
    if (restoring) {
      event.stopImmediatePropagation();
      const resolve = restoring;
      restoring = null;
      resolve();
      return;
    }
    const destination = event.state?.[INDEX];
    // Entries outside this SPA are protected by beforeunload; synthetic auth
    // events and same-entry replacements need no traversal replay.
    if (typeof destination !== "number" || destination === index) return;
    if (replaying || guards.size === 0) {
      index = destination;
      replaying = false;
      return;
    }
    event.stopImmediatePropagation();
    const delta = destination - index;
    const restored = new Promise<void>(resolve => { restoring = resolve; });
    history.go(-delta);
    void restored.then(() => {
      if (disposed) return;
      return requestNavigation(() => {
        if (disposed) return;
        replaying = true;
        history.go(delta);
      });
    });
  };
  window.addEventListener("popstate", onPop, true);
  return () => {
    disposed = true;
    history.pushState = push;
    history.replaceState = replace;
    window.removeEventListener("popstate", onPop, true);
  };
}
