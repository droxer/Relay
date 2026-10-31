"use client";

import { useEffect } from "react";
import { APP_HOME_PATH, isLandingPath, parseAppPath, validatedReturnTo } from "../lib/appRoute";

interface AuthRedirectInput {
  /** Mounted and the auth check has answered. */
  ready: boolean;
  signedIn: boolean;
  /** From useLocationPathname; re-runs the check on every navigation. */
  pathname: string | null;
}

/**
 * Keeps the address in step with who is signed in: a signed-out visitor on a
 * private page goes to sign in (remembering where they were), and a signed-in
 * one on sign-in, a public page, or the bare origin goes on into the app.
 */
export function useAuthRedirect({ ready, signedIn, pathname }: AuthRedirectInput): void {
  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const current = `${window.location.pathname}${window.location.search}`;
    // Request access and redeem an invite are signed-out pages in their own
    // right, not doors to be bounced through sign-in — and a signed-in visitor
    // has no use for either, so they go home. The bare origin is the same:
    // the landing page while signed out, so it is not bounced to sign-in,
    // and a way into /threads once signed in. Read from the address bar, not
    // router state: this can run in the same commit that first parses it.
    const location = parseAppPath(window.location.pathname);
    const onPublicPage = Boolean(location.publicPage);
    const onLanding = isLandingPath(window.location.pathname);
    if (!signedIn && (onPublicPage || onLanding)) return;
    if (!signedIn && window.location.pathname !== "/login") {
      const returnTo = validatedReturnTo(current, window.location.origin);
      const loginUrl = `/login?returnTo=${encodeURIComponent(returnTo)}`;
      window.history.replaceState(window.history.state, "", loginUrl);
      window.dispatchEvent(new PopStateEvent("popstate"));
      return;
    }
    if (signedIn && (location.login || onPublicPage || onLanding)) {
      const returnTo = onPublicPage || onLanding
        ? APP_HOME_PATH
        : validatedReturnTo(new URL(window.location.href).searchParams.get("returnTo"), window.location.origin);
      window.history.replaceState(window.history.state, "", returnTo);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [pathname, ready, signedIn]);
}
