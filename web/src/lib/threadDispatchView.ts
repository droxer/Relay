import { APP_NAVIGATION_EVENT } from "./appRoute";
import { useRelayStore } from "./store";

/** An async result may affect the composer/selection only until the reader leaves.
 * Invalidation is permanent, including a visit away and back during a request.
 */
export function retainThreadDispatchView() {
  const origin = useRelayStore.getState();
  const href = typeof window === "undefined" ? "" : window.location.href;
  let current = true;
  const release = useRelayStore.subscribe((state) => {
    if (state.selectedUser !== origin.selectedUser
      || state.selectedSessionId !== origin.selectedSessionId
      || state.activeSessionId !== origin.activeSessionId
      || state.composingNew !== origin.composingNew
      || state.threadDraftId !== origin.threadDraftId) current = false;
  });
  const checkLocation = () => {
    if (window.location.href !== href) current = false;
  };
  if (typeof window !== "undefined") {
    window.addEventListener("popstate", checkLocation);
    window.addEventListener(APP_NAVIGATION_EVENT, checkLocation);
  }
  return {
    isCurrent: () => current && (typeof window === "undefined" || window.location.href === href),
    release: () => {
      release();
      if (typeof window !== "undefined") {
        window.removeEventListener("popstate", checkLocation);
        window.removeEventListener(APP_NAVIGATION_EVENT, checkLocation);
      }
    },
  };
}
